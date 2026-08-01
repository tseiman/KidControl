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
- `icon` — optional PNG, JPEG, or WebP filename stored under `/etc/kidcontrol/icons`; paths are not accepted
- `pin` — exactly four digits
- `role` — `user`
- `weeklyBudgetMinutes` — all seven English weekday names, each from `0` through `1499`

Superuser fields:

- `id`, `displayName`, and four-digit `pin`
- optional `icon` with the same filename rules as a regular user
- `role` — `superuser`
- no `weeklyBudgetMinutes`

### User icons

Keep user images outside Git under `/etc/kidcontrol/icons`. There is intentionally no browser upload endpoint. Upload a source image to a temporary administrator-controlled location, then install it with a simple filename that matches `config.json`:

```bash
sudo install -d -o root -g kidcontrol -m 0750 /etc/kidcontrol/icons
sudo install -o root -g kidcontrol -m 0640 /path/to/anna.webp /etc/kidcontrol/icons/anna.webp
```

Supported extensions are `.png`, `.jpg`, `.jpeg`, and `.webp`; each file must be no larger than 5 MiB. Square and rectangular images are displayed as circular, center-cropped portraits using `object-fit: cover`. If `icon` is omitted, missing, or unreadable, the WebUI displays safe initials instead. Restart KidControl after changing `config.json`; replacing an image with the same filename may remain browser-cached for up to five minutes.

Device fields:

- `id` — unique stable identifier
- `displayName` — name shown in the WebUI
- `aclRuleName` — exact unique name of the existing blocking UniFi ACL
- `appleTvIdentifier` — exact case-sensitive top-level key written to the Companion credential map; it often looks like a MAC address but is not the display name and must not be guessed from a UniFi Ethernet or Wi-Fi address

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
- `APPLETV_CREDENTIALS=/etc/kidcontrol/.atv-credentials.json`
- `PUBLIC_ORIGIN` — canonical HTTPS origin without a trailing slash
- `TRUSTED_PROXY_IP` — the single reverse-proxy IP seen by KidControl
- `KIDCONTROL_AUTH_PEPPER` — independent 32-byte secret as 64 hexadecimal or 43 base64url characters
- `UNIFI_HOST` — canonical HTTPS origin without a trailing slash
- `UNIFI_SITE_ID` — UniFi Network site ID
- `UNIFI_API_KEY` — restricted Network Integration API key

Optional values:

- `UNIFI_CA_FILE` — leave empty for a publicly trusted UniFi certificate; otherwise use `/etc/kidcontrol/unifi-ca.pem` for a protected private-CA bundle
- `HOST` — default `127.0.0.1`
- `PORT` — default `8080`
- `POLL_SECONDS` — default `5`, allowed range `1` through `300`

Generate the authentication pepper once:

```bash
openssl rand -hex 32
```

Copy the result into the protected environment file. Never reuse the UniFi API key as the pepper.

## 3. CA certificates

For a publicly trusted UniFi certificate, leave `UNIFI_CA_FILE` empty. The UniFi HTTPS server must send its leaf certificate and intermediate certificate(s); Node.js already trusts the public root.

For a private/internal CA only, create `/etc/kidcontrol/unifi-ca.pem`. Put the issuing intermediate CA certificate first and the root CA certificate second. Do not include a private key or the UniFi server's leaf certificate.

```bash
sudo mcedit /etc/kidcontrol/unifi-ca.pem
sudo chown kidcontrol:kidcontrol /etc/kidcontrol/unifi-ca.pem
sudo chmod 0600 /etc/kidcontrol/unifi-ca.pem
```

Set `UNIFI_CA_FILE=/etc/kidcontrol/unifi-ca.pem` after creating it.

The reverse proxy does not use this trust bundle as its server certificate. The default paths are `/etc/nginx/ssl/kidcontrol.fullchain.pem` for the host-specific leaf certificate followed by intermediate certificate(s), and `/etc/nginx/ssl/kidcontrol.key` for the separate private key. The public root is not included in the served full chain. See the main installation guide for ownership and mode commands.

## 4. Pair every Apple TV

**Runtime credential path:** `/etc/kidcontrol/.atv-credentials.json`

Companion credentials are specific to one physical Apple TV. Pairing one device does not authorize any other device. Perform this interactive step on the same network as the Apple TVs, before starting KidControl.

Run the following command once for each Apple TV:

```bash
sudo -u kidcontrol env HOME=/etc/kidcontrol \
  /opt/kidcontrol/code/node_modules/.bin/atv companion-pair
```

For each run:

1. Select exactly one Apple TV from the scan result.
2. Wait for the pairing PIN to appear on that Apple TV.
3. Enter the displayed PIN at the CLI prompt.
4. Wait for `Companion paired!` before pairing the next device.
5. Repeat until every configured Apple TV has been paired.

The CLI creates or updates `/etc/kidcontrol/.atv-credentials.json` as a device-keyed map and enforces mode `0600`. A warning that no AirPlay credentials exist can be ignored for KidControl: KidControl needs Companion pairing, not `atv pair` AirPlay pairing.

Print only the paired device IDs, without displaying credential material:

```bash
sudo -u kidcontrol /usr/bin/node -e \
  "const fs=require('node:fs');const p='/etc/kidcontrol/.atv-credentials.json';console.log(Object.keys(JSON.parse(fs.readFileSync(p,'utf8'))).join('\\n'))"
```

Copy each printed ID exactly into the matching device's `appleTvIdentifier` in `/etc/kidcontrol/config.json`.

Optionally verify one device with a read-only Companion power-state query. The following prompts for the exact paired ID so it does not contain a non-working placeholder:

```bash
read -r -p "Exact paired Apple TV identifier: " ATV_ID
sudo -u kidcontrol env HOME=/etc/kidcontrol \
  /opt/kidcontrol/code/node_modules/.bin/atv power "$ATV_ID"
unset ATV_ID
```

A result of `unknown` is not proof of standby. It indicates that no authoritative power state was available.

Never open, copy, log, or commit the serialized credential values. To add another Apple TV later, stop KidControl, run `companion-pair` once for the new device using the same `HOME`, update `config.json`, and restart the service.

## Apply and verify

Configuration is read at startup. Restart the service after a change:

```bash
sudo systemctl restart kidcontrol.service
sudo systemctl status --no-pager kidcontrol.service
sudo journalctl -u kidcontrol.service -n 50 --no-pager
```

A startup validation error names the invalid field. Fix the file rather than bypassing validation.
