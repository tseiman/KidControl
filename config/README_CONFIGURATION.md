# KidControl Configuration

KidControl uses three protected runtime files. Keep all three outside Git. Run the installation commands below from the repository root.

## 1. User and device configuration

**Runtime path:** `/etc/kidcontrol/config.json`

**Template:** [`config.example.json`](config.example.json)

```bash
sudo install -o kidcontrol -g kidcontrol -m 0600 config/config.example.json /etc/kidcontrol/config.json
sudo mcedit /etc/kidcontrol/config.json
```

Required top-level fields:

- `timezone` — must be `Europe/Berlin`
- `users` — regular users and superusers
- `devices` — managed Apple TVs and their exact UniFi ACL mappings

Regular user fields:

- `id` — unique stable identifier
- `displayName` — name shown in the WebUI
- `pin` — exactly four digits
- `role` — `user`
- `weeklyBudgetMinutes` — all seven English weekday names, each from `0` through `1499`

Superuser fields:

- `id`, `displayName`, and four-digit `pin`
- `role` — `superuser`
- no `weeklyBudgetMinutes`

Device fields:

- `id` — unique stable identifier
- `displayName` — name shown in the WebUI
- `aclRuleName` — exact unique name of the existing blocking UniFi ACL
- `appleTvIdentifier` — identifier used by the paired Companion credentials

Do not remove a device while it may still be allowed or pending. Stop its claims, run **Restore KidControl State**, verify that its ACL is blocked, and then remove it.

## 2. Service environment

**Runtime path:** `/etc/kidcontrol/kidcontrol.env`

**Template:** [`../code/.env.example`](../code/.env.example)

```bash
sudo install -o root -g root -m 0600 code/.env.example /etc/kidcontrol/kidcontrol.env
sudo mcedit /etc/kidcontrol/kidcontrol.env
```

Required values:

- `KIDCONTROL_CONFIG=/etc/kidcontrol/config.json`
- `KIDCONTROL_DB=/var/lib/kidcontrol/state.sqlite`
- `APPLETV_CREDENTIALS=/etc/kidcontrol/apple-tv.json`
- `PUBLIC_ORIGIN` — canonical HTTPS origin without a trailing slash
- `TRUSTED_PROXY_IP` — the single reverse-proxy IP seen by KidControl
- `KIDCONTROL_AUTH_PEPPER` — independent 32-byte secret as 64 hexadecimal or 43 base64url characters
- `UNIFI_HOST` — canonical HTTPS origin without a trailing slash
- `UNIFI_SITE_ID` — UniFi Network site ID
- `UNIFI_API_KEY` — restricted Network Integration API key

Optional values:

- `UNIFI_CA_FILE` — protected custom CA file for UniFi HTTPS
- `HOST` — default `127.0.0.1`
- `PORT` — default `8080`
- `POLL_SECONDS` — default `5`, allowed range `1` through `300`

Generate the authentication pepper once:

```bash
openssl rand -hex 32
```

Copy the result into the protected environment file. Never reuse the UniFi API key as the pepper.

## 3. Apple TV credentials

**Runtime path:** `/etc/kidcontrol/apple-tv.json`

This file is the credential map produced by the paired `node-appletv-remote` workflow. Each configured `appleTvIdentifier` must have one entry containing Companion credentials.

```bash
sudo mcedit /etc/kidcontrol/apple-tv.json
sudo chown kidcontrol:kidcontrol /etc/kidcontrol/apple-tv.json
sudo chmod 0600 /etc/kidcontrol/apple-tv.json
```

Never place pairing material in the repository, logs, issues, or documentation.

## Apply and verify

Configuration is read at startup. Restart the service after a change:

```bash
sudo systemctl restart kidcontrol.service
sudo systemctl status --no-pager kidcontrol.service
sudo journalctl -u kidcontrol.service -n 50 --no-pager
```

A startup validation error names the invalid field. Fix the file rather than bypassing validation.
