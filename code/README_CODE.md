# KidControl Implementation

This directory contains the production TypeScript service, automated tests, and mobile WebUI.

## Architecture

- `src/domain.ts` — strict JSON configuration and Berlin calendar helpers
- `src/store.ts` — versioned SQLite schema, transactions, claims, ledger, authentication, ACL, power, and audit state
- `src/kid-control.ts` — serialized policy engine, accounting, recovery, and reconciliation
- `src/unifi.ts` — official local UniFi API adapter with HTTPS, timeout, response limits, allowlisted PUT payload, and readback
- `src/apple-tv.ts` — resilient Companion monitor using `node-appletv-remote`
- `src/auth.ts` — opaque cookie sessions, keyed authentication fingerprints, CSRF, and rate limiting
- `src/server.ts` — framework-light `node:http` API and static WebUI
- `src/runtime.ts` — deployment environment validation
- `src/main.ts` — production wiring and graceful shutdown
- `public/` — dependency-free smartphone WebUI

The policy engine serializes all local mutations and reconciliation work through one queue. External network calls never run inside a SQLite transaction.

## Runtime requirements

- Node.js `>=22.12.0`
- a TLS reverse proxy
- protected JSON configuration and Companion credentials
- a dedicated writable state directory
- UniFi Network Integration API access

## Install, test, and build

```bash
npm ci
npm test
npm run build
```

Run the compiled application with:

```bash
npm start
```

`npm run build` copies `public/` and `../docs/README_KIDCONTROL.md` into `dist/`.

## Environment

Use [`.env.example`](.env.example) as a field list. The application does not load `.env` files itself; systemd supplies the protected environment file.

Required:

- `KIDCONTROL_CONFIG` — absolute path to the mode-`0600` user/device JSON file
- `KIDCONTROL_DB` — absolute SQLite path inside a private state directory
- `APPLETV_CREDENTIALS` — absolute path to the mode-`0600` CLI-compatible credential map
- `PUBLIC_ORIGIN` — canonical external HTTPS origin, with no trailing slash
- `TRUSTED_PROXY_IP` — the single reverse-proxy IPv4 or IPv6 address seen by KidControl
- `KIDCONTROL_AUTH_PEPPER` — independent 32-byte value encoded as 64 hexadecimal characters or 43 base64url characters
- `UNIFI_HOST` — canonical HTTPS origin of the UniFi Console
- `UNIFI_SITE_ID` — UniFi Network site ID
- `UNIFI_API_KEY` — restricted Integration API key

Optional:

- `UNIFI_CA_FILE` — absolute mode-`0600` custom CA file; TLS verification always remains enabled
- `HOST` — listener address, default `127.0.0.1`
- `PORT` — listener port, default `8080`
- `POLL_SECONDS` — accounting/reconciliation interval from 1 to 300 seconds, default `5`

There is deliberately no insecure HTTP or certificate-verification bypass.

## Configuration schema

See [`../config/config.example.json`](../config/config.example.json). Important validation rules:

- timezone must be exactly `Europe/Berlin`;
- user and device IDs must be unique;
- PINs contain exactly four digits;
- regular users define all seven weekday budgets from `0` through `1499` minutes;
- superusers do not define a budget;
- ACL rule names are unique and matched exactly;
- every device has a Companion Apple TV identifier.

## Apple TV pairing

Pairing is a mandatory installation step. Every physical Apple TV must be paired separately because Companion credentials are device-specific. With KidControl stopped, run this once per Apple TV after installing the production dependency:

```bash
sudo -u kidcontrol env HOME=/etc/kidcontrol \
  /opt/kidcontrol/code/node_modules/.bin/atv companion-pair
```

Select one device, enter the PIN shown on that Apple TV, wait for `Companion paired!`, and repeat for the next device. The shared `HOME` makes the CLI safely update `/etc/kidcontrol/.atv-credentials.json`; set `APPLETV_CREDENTIALS` to that path. Use each map key exactly as the matching `appleTvIdentifier`. AirPlay pairing with `atv pair` is not required. See the [configuration quick guide](../config/README_CONFIGURATION.md) for safe ID listing and read-only power verification.

## HTTP and proxy contract

The service validates every `Host` against `PUBLIC_ORIGIN`. Every POST, including login, also requires the exact external `Origin`. The reverse proxy must therefore preserve the public host and terminate HTTPS. It must overwrite, not append to, `X-Forwarded-For` with exactly one client IP. KidControl accepts that header only when the socket peer exactly matches `TRUSTED_PROXY_IP`; a missing, comma-separated, or invalid value is rejected at login. Authentication uses a `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-` cookie.

For Nginx, the relevant proxy assignments are:

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-For $remote_addr;
```

Useful endpoints:

- `GET /health` — `ok` or `degraded`, without secrets
- `GET /api/public` — safe login choices
- `POST /api/login`
- `GET /api/session` — resume a cookie session and obtain a fresh CSRF token
- `GET /api/status`
- `POST /api/claim`
- `POST /api/stop`
- `POST /api/logout`
- `POST /api/admin/adjust`
- `POST /api/admin/restore`

## Accounting and recovery

Times are persisted as integer epoch seconds and charged as half-open intervals. Ledger entries are split at Berlin midnight. If the service is unavailable while a claim exists, the interval is conservatively charged at recovery. Charging stops at the exact budget-exhaustion second, including across midnight and DST transitions.

SQLite enables foreign keys, a busy timeout, `synchronous=FULL`, and WAL for file-backed databases. The service applies umask `0077` and mode `0600` to database files.

Do not remove a device from configuration while its persisted claim or ACL state may still be allowed or pending. Recovery deliberately refuses startup because the reduced configuration no longer contains enough trusted ACL identity to block that device. Restore the previous configuration, stop its claims, run **Restore KidControl State**, verify the ACL is blocked, and only then remove the device.

## Live deployment checklist

Before production use:

1. Revoke any previously exposed UniFi API key and create a restricted replacement.
2. Confirm each configured ACL name resolves to exactly one blocking rule.
3. Test block, unblock, timeout, and readback behavior for each rule.
4. Pair each Apple TV and verify the credentials contain `companionCredentials`.
5. Verify `Asleep`, `Screensaver`, `Awake`, `Idle`, disconnect, and reconnect on each physical Apple TV.
6. Confirm wake never starts a claim and network loss produces `unknown`.
7. Confirm existing Apple TV audio output configuration is unchanged.
8. Test restart recovery, an externally changed ACL, and **Restore KidControl State**.
9. Verify the TLS reverse proxy, cookie behavior, file ownership, and systemd sandbox.
   Install `/etc/kidcontrol/kidcontrol.env` as `root:root` mode `0600`; it contains the UniFi API key and authentication pepper.
10. Back up and restore the SQLite state file while the service is stopped.

Never paste API keys, PINs, cookie tokens, pairing material, or the authentication pepper into logs, issues, or Git.
