# KidControl

## System requirements summary

- **Recommended VM:** 1 vCPU, 512 MiB RAM, 1 GiB free disk
- **Measured service footprint:** about 80 MiB idle RSS, effectively 0% idle CPU, 224 KiB built application, about 180 KiB initial SQLite state
- **Software:** Debian 12/13, Node.js `>=22.12.0`, npm, Git, systemd, and an HTTPS reverse proxy
- **External requirements:** UniFi Network Integration API, one uniquely named blocking ACL per Apple TV, and paired Companion credentials

The recommendation includes reserve for Debian, the TLS proxy, production dependencies, SQLite growth, and the systemd journal. The measurement used the built production modules with local fake UniFi and Apple TV adapters; no real LAN device was contacted.

KidControl provides time-budgeted network access for wired Apple TVs. Users authenticate in a smartphone-oriented WebUI, claim a managed Apple TV, and consume a daily budget. KidControl controls existing blocking ACL rules through the official local UniFi Network Integration API and observes confirmed Apple TV standby through Companion Link.

## Status

The TypeScript initial release includes:

- per-second accounting in `Europe/Berlin`, including midnight, DST, and restart recovery;
- shared-device claims, daily budgets, and unlimited superusers;
- durable desired/actual UniFi ACL reconciliation;
- Companion `on` / `off` / `unknown` monitoring and reconnects;
- SQLite persistence;
- secure cookie authentication, CSRF protection, and login throttling;
- a dependency-free mobile WebUI;
- a hardened systemd unit.

Automated tests use fake external adapters and never contact live UniFi or Apple TV systems. Production deployment still requires an end-to-end test with every configured ACL and Apple TV.

## Default installation

This is the supported default path: build from the repository, install under `/opt/kidcontrol`, store configuration under `/etc/kidcontrol`, and run the service as the dedicated `kidcontrol` user.

### 1. Build and test

Run from the repository root:

```bash
cd code
npm ci
npm test
npm run build
cd ..
```

### 2. Create the service account and directories

```bash
sudo useradd --system --home-dir /var/lib/kidcontrol --shell /usr/sbin/nologin kidcontrol
sudo install -d -o root -g root -m 0755 /opt/kidcontrol/code
sudo install -d -o kidcontrol -g kidcontrol -m 0700 /etc/kidcontrol
sudo install -d -o kidcontrol -g kidcontrol -m 0700 /var/lib/kidcontrol
```

### 3. Install the application

```bash
sudo cp -a code/dist code/package.json code/package-lock.json /opt/kidcontrol/code/
sudo chown -R root:root /opt/kidcontrol
sudo npm --prefix /opt/kidcontrol/code ci --omit=dev
```

### 4. Install and edit the protected configuration

```bash
sudo install -o kidcontrol -g kidcontrol -m 0600 config/config.example.json /etc/kidcontrol/config.json
sudo install -o root -g root -m 0600 code/.env.example /etc/kidcontrol/kidcontrol.env
sudo mcedit /etc/kidcontrol/config.json
sudo mcedit /etc/kidcontrol/kidcontrol.env
sudo mcedit /etc/kidcontrol/apple-tv.json
sudo chown kidcontrol:kidcontrol /etc/kidcontrol/apple-tv.json
sudo chmod 0600 /etc/kidcontrol/apple-tv.json
```

Replace every dummy user, PIN, budget, ACL name, Apple TV identifier, path, origin, site ID, and API key. Put the existing paired Companion credential map in `apple-tv.json`.

Generate the required independent authentication pepper once and copy it into `KIDCONTROL_AUTH_PEPPER` in the protected environment file:

```bash
openssl rand -hex 32
```

Do not commit or share the resulting pepper, UniFi API key, PINs, cookie tokens, or Companion credentials.

The HTTPS reverse proxy must preserve the public host and overwrite the client address with exactly one value:

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-For $remote_addr;
```

Set `TRUSTED_PROXY_IP` to the proxy address as seen by KidControl. `PUBLIC_ORIGIN` and `UNIFI_HOST` must both use HTTPS.

### 5. Install and start the systemd service

The checked-in unit is [`etc/kidcontrol.service`](etc/kidcontrol.service).

```bash
sudo install -o root -g root -m 0644 etc/kidcontrol.service /etc/systemd/system/kidcontrol.service
sudo systemctl daemon-reload
sudo systemctl enable --now kidcontrol.service
sudo systemctl status --no-pager kidcontrol.service
```

Follow service logs with:

```bash
sudo journalctl -u kidcontrol.service -f
```

The service binds to `127.0.0.1:8080` by default. Expose it only through the configured HTTPS reverse proxy.

## Safety semantics

- Only confirmed Companion `Asleep → off` ends normal regular-user claims.
- `on`, `unknown`, disconnects, and network errors never fabricate standby.
- Wake does not start or resume a claim.
- Active claims are conservatively charged through downtime until restart or exact budget exhaustion.
- External UniFi changes are adopted during normal reconciliation.
- An external no-claim allowance remains the baseline until an explicit superuser restore.
- A failed first unblock does not start billable usage.
- Removing a device that may still be allowed or pending deliberately blocks startup until it is safely restored with the previous configuration.

## Documentation

- [Detailed implementation and operations](code/README_CODE.md)
- [Requirements and architecture](docs/README_KIDCONTROL.md)
- [Example configuration](config/config.example.json)
- [systemd service](etc/kidcontrol.service)

## License

[MIT](LICENSE)
