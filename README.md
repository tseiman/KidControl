# KidControl

KidControl provides time-budgeted network access for wired Apple TVs. Users authenticate in a smartphone-oriented WebUI, claim a managed Apple TV, and consume a daily per-user budget. KidControl controls existing blocking ACL rules through the official local UniFi Network Integration API and observes confirmed Apple TV standby through Companion Link.

## Status

The TypeScript initial-release implementation is available under [`code/`](code/). It includes:

- per-second daily accounting in `Europe/Berlin`;
- restart and downtime recovery;
- shared-device claims and one active claim per user;
- unlimited superusers, displacement, adjustments, and restore;
- durable desired/actual UniFi ACL reconciliation;
- Companion `on` / `off` / `unknown` monitoring;
- SQLite persistence;
- secure cookie authentication, CSRF protection, and login throttling;
- a responsive dependency-free WebUI;
- a hardened systemd service example.

Automated tests use fake UniFi and Apple TV adapters and never contact live services. The underlying `node-appletv-remote` Companion implementation has been hardware-validated separately. A deployment still requires final end-to-end tests with every configured ACL and Apple TV.

## Requirements

- Debian 12 or 13
- Node.js `>=22.12.0` (Node.js 22 is selected by [`.nvmrc`](.nvmrc))
- npm
- a TLS reverse proxy for the public KidControl origin
- a UniFi Console with the Network Integration API
- one existing, uniquely named blocking ACL rule per Apple TV
- Companion-paired Apple TV credentials stored outside Git

KidControl uses the built-in `node:sqlite` module. Node.js 22 currently prints an experimental-module warning for this API; the application pins its minimum Node version and tests the SQLite behavior it relies on.

## Build and test

```bash
cd code
npm ci
npm test
npm run build
```

The build writes JavaScript, the WebUI, and a copy of the canonical requirements document to `code/dist/`.

## Configuration

1. Copy [`config/config.example.json`](config/config.example.json) to a protected runtime location such as `/etc/kidcontrol/config.json`.
2. Replace every example user, PIN, budget, ACL rule name, and Apple TV identifier.
3. Store the file with mode `0600`, owned by the service account.
4. Install [`code/.env.example`](code/.env.example) as `/etc/kidcontrol/kidcontrol.env`, owned by `root:root` with mode `0600`, and fill in the deployment values. Do not use a plain copy that may retain mode `0644`.
5. Generate an independent 32-byte authentication pepper, for example with `openssl rand -hex 32`, and store it only in the protected environment file.
6. Store the Companion credential map with mode `0600`, owned by the service account.

Required environment values are documented in [`code/README_CODE.md`](code/README_CODE.md). The UniFi API key, authentication pepper, PIN configuration, and Apple TV credentials must never be committed.

## Deployment

[`deploy/kidcontrol.service`](deploy/kidcontrol.service) is a hardened systemd example for a dedicated `kidcontrol` account. It expects:

- application: `/opt/kidcontrol`;
- configuration and environment: `/etc/kidcontrol`;
- state database: `/var/lib/kidcontrol/state.sqlite`;
- loopback listener: `127.0.0.1:8080` by default;
- HTTPS termination at a reverse proxy preserving the configured public `Host` and `Origin`, connecting from `TRUSTED_PROXY_IP`, and overwriting `X-Forwarded-For` with the single client IP.

Install and enable the unit only after adapting and reviewing all paths:

```bash
sudo install -m 0644 deploy/kidcontrol.service /etc/systemd/system/kidcontrol.service
sudo systemctl daemon-reload
sudo systemctl enable --now kidcontrol.service
sudo systemctl status kidcontrol.service
```

KidControl rejects non-HTTPS public and UniFi origins. A private UniFi CA can be supplied through `UNIFI_CA_FILE`; certificate verification remains enabled.

## Safety semantics

- Only confirmed Companion `Asleep → off` ends regular claims normally.
- `on`, `unknown`, disconnects, and network errors never fabricate standby.
- Wake does not start or resume a claim.
- Active claims are conservatively charged through service downtime until restart or the exact budget-exhaustion second.
- External UniFi changes are adopted during normal reconciliation.
- An external no-claim allowance remains the baseline until a superuser explicitly runs **Restore KidControl State**.
- A failed first unblock does not start billable usage.

## Documentation

- [Requirements and architecture](docs/README_KIDCONTROL.md)
- [Implementation, configuration, and operations](code/README_CODE.md)

## License

[MIT](LICENSE)
