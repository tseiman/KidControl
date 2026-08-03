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
- `public/` — dependency-free smartphone WebUI with profile tiles, safe icon fallbacks, an accessible superuser picker, and client-side English/German localization

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

`npm run build` copies `public/` into `dist/public`, writes the embedded revision to `dist/version.txt`, and copies `../docs/README_KIDCONTROL.md` to `dist/documentation.md`.

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

- `UNIFI_CA_FILE` — absolute mode-`0600` private-CA bundle owned by `kidcontrol`; leave empty for publicly trusted certificates because Node.js uses its public trust store
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
- every device has a Companion Apple TV identifier;
- each optional user `icon` is a simple PNG, JPEG, or WebP filename served from `/etc/kidcontrol/icons` through the user-ID-based icon endpoint.

Regular users can create a claim only while the latest authoritative Apple TV power state is `on`. The WebUI mirrors this rule with a disabled Start button and the serialized core enforces it against direct API calls. Superusers may create claims while power is `off` or `unknown`.

The login view is a profile-tile grid rather than a native select. Optional user images are loaded before authentication through `/api/user-icons/<user-id>`; the server accepts only configured regular files beneath `/etc/kidcontrol/icons`, allowlists `.png`/`.jpg`/`.jpeg`/`.webp` filename extensions, enforces a 5 MiB limit, and rejects path components, leading dots, unsupported extensions, and symlinks. It assigns MIME type from the validated extension rather than decoding image content. Browser favicons and Apple touch icons are likewise public static assets. The UI displays center-cropped circular portraits and falls back to safe initials. The superuser target control is a keyboard- and ARIA-accessible custom picker for regular users that includes portrait, name, and remaining time. See the [configuration quick guide](../config/README_CONFIGURATION.md#user-icons) for installation and ownership.

The WebUI selects the first supported entry from `navigator.languages` (`en` or `de`), uses `navigator.language` when that list is empty, and falls back to English when neither yields a supported language. Translation is entirely client-side; the server only serves the static `i18n.js` module. During `npm run build`, the same Git revision used by the startup banner is injected into the version tag below the documentation link.

Browser branding assets also live in `public/`: `favicon.ico` contains the conventional 16–64 px favicon sizes, `icon.png` is the high-resolution PNG, and the opaque 180×180 `apple-touch-icon.png` is used when KidControl is added to an Apple home screen. The production static-file allowlist serves all three with explicit image MIME types.

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
- `GET /api/user-icons/<user-id>` — public pre-login portrait without exposing its filename or filesystem path
- `POST /api/login`
- `GET /api/session` — resume a cookie session and obtain a fresh CSRF token
- `GET /api/status`
- `POST /api/claim`
- `POST /api/stop`
- `POST /api/logout`
- `POST /api/admin/adjust`
- `POST /api/admin/restore`

## Service logging

The example systemd unit appends application stdout to `/var/log/kidcontrol/kidcontrol.log` and stderr to `/var/log/kidcontrol/kidcontrol_error.log`. KidControl writes single-line `key=value` operational events to these streams. String values are quoted and safely escape quotes, backslashes, and line breaks:

- `login` — user ID/name and validated client IP;
- `session-start` — user, Apple TV, and remaining seconds;
- `session-progress` — active user, Apple TV, and remaining seconds once per 15-minute interval;
- `session-stop` — user, Apple TV, remaining seconds, and reason such as `manual`, `apple-tv-off`, or `budget-exhausted`;
- `budget-change` — daily budget allocation or a superuser adjustment including amount, target, and author;
- `request-error` and `acl-error` — unexpected request or UniFi ACL failures without credentials.

PINs, cookies, CSRF values, API keys, and Apple TV credentials are never included. The example unit uses `LogsDirectory=kidcontrol` and `LogsDirectoryMode=0750`; systemd therefore creates `/var/log/kidcontrol` as `kidcontrol:kidcontrol` when needed. `UMask=0077` protects newly created log files. Follow them with:

```bash
sudo tail -F /var/log/kidcontrol/kidcontrol.log /var/log/kidcontrol/kidcontrol_error.log
```

For example, filter session stops with `grep 'event=session-stop' /var/log/kidcontrol/kidcontrol.log`.

systemd manager messages remain available through `sudo journalctl -u kidcontrol.service` but no longer contain normal application stdout/stderr when the example unit is installed.

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
