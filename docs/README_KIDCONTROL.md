# KidControl — Requirements and Architecture

## 1. Objective

KidControl manages daily usage budgets for multiple wired Apple TVs. Authenticated users select a device in a smartphone WebUI and start or stop their usage. During an active session, KidControl disables the UniFi ACL rule that blocks the selected Apple TV. The rule is enabled again when no active claim remains.

A budget can be split into any number of intervals and used across different Apple TVs. For example, a one-hour daily budget can be consumed in sessions of 5, 30, and 25 minutes on one or more devices. Usage is charged with one-second precision, and the remaining time is displayed as `hh:mm:ss`.

## 2. Defined Scope

- initially approximately two, eventually up to ten managed devices;
- internal LAN access only, with the planned FQDN `kidcontrol.tsei.mdn`;
- a lightweight Debian 12 or Debian 13 VM as the target system;
- a WebUI designed primarily for smartphones;
- username selection from a list and a four-digit PIN;
- authentication remains valid until the user logs out manually;
- users, PINs, roles, weekly budgets, and device mappings stored in a configuration file;
- sessions, usage, time adjustments, and runtime state stored in a lightweight, Node.js-compatible SQLite database;
- user administration exclusively through the configuration file, not through the WebUI;
- superuser functions provided through the WebUI;
- operational logging to standard output/error and therefore to the systemd journal without a dedicated Node.js syslog library; additional log files remain optional.

Clear-text PINs are a deliberate simplification for the internal network. The significantly more powerful UniFi API key must nevertheless never be stored in source code, user configuration, or Git.

## 3. UniFi Interface

### Verified Approach

The existing, successfully tested script uses the official local UniFi Network Integration API:

- base route: `/proxy/network/integration/v1/sites/{siteId}`;
- authentication: API key in the `X-API-Key` HTTP header;
- list ACL rules: `GET /acl-rules`;
- update an ACL rule: `PUT /acl-rules/{aclRuleId}`;
- enabled blocking rule: Apple TV is blocked;
- disabled blocking rule: Apple TV is allowed network access.

KidControl must not create or delete the existing ACL structure. It only reads explicitly configured rules and changes their `enabled` field. Display names and ACL rules are mapped explicitly so that unrelated network rules never appear in the WebUI.

Example of a preliminary device configuration:

```json
{
  "devices": [
    {
      "id": "living-room",
      "displayName": "Living Room",
      "aclRuleName": "KC AppleTV Living Room",
      "appleTvIdentifier": "to-be-defined"
    }
  ]
}
```

### API Configuration

The runtime requires at least:

- the UniFi host;
- the site ID;
- a new UniFi API key supplied through a protected secret or environment file.

The previously submitted key must be treated as exposed and revoked before deployment. The specific host, site ID, and API key will not be stored in the repository.

### Sources

- [Ubiquiti: Getting Started with the Official UniFi API](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
- [UniFi Developer Portal: Network API](https://developer.ui.com/network/)
- Documentation matching the installed Network version and API key management are also available locally under **UniFi Network → Control Plane → Integrations**.

## 4. Time and Policy Model

### Daily Budget

- Every regular user has one default budget for each day from Monday through Sunday.
- Defaults are entered as hours and minutes.
- Internal accounting uses one-second precision.
- The day changes at midnight in the `Europe/Berlin` time zone, including CET/CEST transitions.
- Unused time expires at the end of the day.
- Holidays and other exceptions are handled manually through configuration or a daily adjustment.

Effective remaining time:

```text
Remaining = daily default + today's superuser adjustment - today's usage
```

The value never becomes negative for regular users. When it reaches zero, KidControl immediately ends any active session.

### Superusers

A superuser:

- has unlimited usage time;
- can set a regular user's remaining time for the current day directly from `00:00` through `24:59`;
- can therefore add, reduce, remove completely, or restore time;
- preferably selects hours and minutes with animated scrolling controls;
- can trigger a manual **Restore KidControl State** reset;
- displaces regular sessions on the selected Apple TV.

Displaced regular sessions are paused and are not resumed automatically. Once superuser usage ends, a regular user must press **Start** again.

## 5. Multi-User and Device State

### Claims Instead of ACL State Alone

An ACL only represents blocked or allowed network access. KidControl therefore maintains an individual usage claim for each user:

- A user can have at most one active claim.
- Selecting a second device immediately ends that user's claim on the first device.
- The first device is blocked only if no other active claim remains there.
- Multiple regular users may hold claims on the same Apple TV at the same time.
- Each of these users consumes their own budget while their claim is active.
- A user can stop only their own claim.
- The ACL remains disabled while at least one valid claim exists.
- The WebUI does not explicitly indicate that another user has already enabled the device.

```mermaid
stateDiagram-v2
    [*] --> Blocked
    Blocked --> Allowed: first claim starts
    Allowed --> Allowed: another claim starts or ends
    Allowed --> Blocked: last claim ends
    Allowed --> Blocked: budget exhausted or standby
```

### Switching Apple TVs

When a user switches devices:

1. charge and close the previous session with one-second precision;
2. enable the old ACL if no other claim remains there;
3. verify the remaining budget;
4. persist the new claim;
5. disable the new ACL;
6. read the result back through the UniFi API.

The database update and external ACL request cannot share a transaction. The implementation therefore needs a traceable desired/actual-state reconciliation process and idempotent retries.

## 6. Standby Detection

An Apple TV can remain online from a network perspective while sleeping. Ping and the UniFi online state are therefore insufficient. [`pyatv`](https://pyatv.dev/) is the preferred option to investigate.

Required behavior:

- Standby ends the affected regular sessions.
- Usage up to that point is stored with one-second precision.
- The ACL is enabled as soon as no other claim remains.
- Waking the Apple TV does not restart a session automatically.
- The user must press **Start** again.

Important limitation: according to `pyatv`, the power state is partly derived from connected output devices and can be unreliable when, for example, HomePods or external audio devices are used. The final architecture therefore requires testing with the actual Apple TVs. The test must cover detection, initial pairing, stored credentials, response time, and behavior with the existing audio outputs.

## 7. Authentication and User Configuration

Preliminary structure:

```json
{
  "timezone": "Europe/Berlin",
  "users": [
    {
      "id": "user-1",
      "displayName": "User 1",
      "pin": "1234",
      "role": "user",
      "weeklyBudgetMinutes": {
        "monday": 60,
        "tuesday": 60,
        "wednesday": 60,
        "thursday": 60,
        "friday": 60,
        "saturday": 120,
        "sunday": 120
      }
    }
  ]
}
```

The example PIN is not a production credential. The schema, file path, and validation rules will be finalized before implementation.

Authentication uses a random, server-side revocable cookie with at least `HttpOnly` and `SameSite=Strict`. “Until logout” means a long-lived authenticated session, not storage of the PIN in the browser. Changing a PIN or removing a user must be able to revoke existing sessions.

## 8. Persistence and Restart

SQLite stores at least:

- completed and active usage sessions;
- start, stop, and accounting timestamps;
- daily usage per user;
- superuser adjustments with timestamp and author;
- the active claim for each user and Apple TV;
- the last known and desired ACL state;
- adopted external states and manual resets.

State-oriented recovery applies after a restart:

1. load stored active sessions and charge usage up to the restart time;
2. check the day boundary and remaining budgets;
3. read the current state of all managed ACLs;
4. continue valid stored claims;
5. set ACLs according to the recovered state;
6. read back and log the result.

For a longer service outage, a feasibility test must determine whether the complete interval until restart counts as usage. The safer budget rule is that a previously active session continues to count until KidControl can reliably establish standby or a stop event.

## 9. External ACL Changes

During normal operation, KidControl adopts an ACL change made outside the application as the actual state and logs it. It does not immediately overwrite the change. Consequently:

- externally blocked: stop and account for affected local claims;
- externally allowed without a claim: record an external allowance without charging any user's time;
- the database then contains the newly documented state.

A superuser can deliberately apply the opposite direction with **Restore KidControl State**: KidControl evaluates valid local claims and policies and sets managed ACLs to the resulting desired state.

## 10. Proposed Architecture

```mermaid
flowchart LR
    UI[Smartphone WebUI] --> APP[KidControl service]
    APP --> CFG[User and device configuration]
    APP --> DB[(SQLite)]
    APP --> UNIFI[UniFi Network API]
    APP --> ATV[Apple TV state adapter]
    APP --> LOG[stdout / stderr]
    LOG --> JOURNAL[systemd journal]
    DOC[docs/README_KIDCONTROL.md] --> UI
```

Recommended division:

- JavaScript/Node.js for the HTTP API, WebUI, authentication, time logic, and UniFi access;
- SQLite as a single local database file;
- a small local `pyatv` adapter only if device testing provides reliable standby signals;
- systemd for startup, restarts, and journal logging;
- as few frameworks as practical, with no separate database server or queue.

Node.js can write to stdout/stderr without a dedicated syslog dependency. A systemd service automatically captures this output in the journal, leaving operation and rotation to the existing Debian tools.

## 11. Deliberately Open Technical Decisions

Small feasibility tests are required before production code is written:

1. **Standby:** pair `pyatv` with the actual devices and verify sleep/wake detection.
2. **SQLite:** compare modern built-in `node:sqlite` with an established Node.js SQLite library. The goal is Debian 12 compatibility with minimal installation overhead.
3. **Web stack:** compare a framework-light server/frontend implementation with a small established stack.
4. **UniFi test:** use a newly generated temporary API key to read, toggle, and read back an explicitly named test ACL.
5. **Outage window:** test behavior during service downtime, at midnight, and across daylight-saving transitions.

The implementation will use JavaScript, not TypeScript. The `package.json`, dependencies, and installation instructions will only be finalized after these tests.

## 12. Documentation in the WebUI

The WebUI will render this file as HTML. The deployment process copies this source file into the documentation server's content directory; no documentation symlink is maintained inside the project.

## 13. Acceptance Criteria for a Future Initial Release

- Login through username selection and a four-digit PIN.
- Long-lived authentication until logout.
- Start, stop, and switch an Apple TV.
- Per-second, cross-device budget accounting.
- Seven daily defaults per user.
- Automatic termination when standby is reliably detected.
- Correct multi-user claims on the same device.
- Immediate termination when remaining time reaches zero.
- Superuser usage, time adjustments, displacement, and reset.
- Recovery after restart.
- Adoption and logging of external ACL changes.
- No secrets in the repository.
- Display of this documentation in the WebUI.
