# <img src="code/public/apple-touch-icon.png" alt="KidControl icon" width="36" height="36" align="top"> KidControl

## Table of contents

- [Documentation](#documentation)
- [System requirements summary](#system-requirements-summary)
- [Status](#status)
- [Default installation](#default-installation)
- [Updating KidControl](#updating-kidcontrol)
- [Safety semantics](#safety-semantics)
- [License](#license)

## Documentation

- [Detailed implementation and operations](code/README_CODE.md)
- [Requirements and architecture](docs/README_KIDCONTROL.md)
- [Configuration quick guide](config/README_CONFIGURATION.md)
- [Example configuration](config/config.example.json)
- [systemd service](etc/kidcontrol.service)

## System requirements summary

- **Recommended VM:** 1 vCPU, 512 MiB RAM, 1 GiB free disk
- **Measured service footprint:** about 80 MiB idle RSS, effectively 0% idle CPU, 1.5 MiB built application including WebUI icons, about 180 KiB initial SQLite state
- **Software:** x86-64 Debian 12/13, Node.js `>=22.12.0`, npm, Git, systemd, and an HTTPS reverse proxy
- **External requirements:** UniFi Network Integration API, one uniquely named blocking ACL per Apple TV, and paired Companion credentials

The recommendation includes reserve for Debian, the TLS proxy, production dependencies, SQLite growth, and the systemd journal. The measurement used the built production modules with local fake UniFi and Apple TV adapters; no real LAN device was contacted.

KidControl provides time-budgeted network access for wired Apple TVs. Users authenticate in a smartphone-oriented WebUI, claim a managed Apple TV, and consume a daily budget. KidControl controls existing blocking ACL rules through the official local UniFi Network Integration API and observes confirmed Apple TV standby through Companion Link.

## Status

The production TypeScript implementation includes:

- per-second accounting in `Europe/Berlin`, including midnight, DST, and restart recovery;
- shared-device claims, daily budgets, and unlimited superusers;
- durable desired/actual UniFi ACL reconciliation;
- Companion `on` / `off` / `unknown` monitoring and reconnects;
- SQLite persistence;
- secure cookie authentication, CSRF protection, and login throttling;
- a dependency-free mobile WebUI with profile tiles, optional user avatars, and safe initials as fallback;
- client-side English/German localization selected from browser preferences, with English as the default;
- regular-user starts only while Apple TV power is confirmed `on`, plus superuser override for `off` and `unknown`;
- a visible build revision, browser favicon, and Apple home-screen icon;
- a hardened systemd unit.

Automated tests use fake external adapters and never contact live UniFi or Apple TV systems. Production deployment still requires an end-to-end test with every configured ACL and Apple TV.

## Default installation

This is the supported default path: build from the repository, install under `/opt/kidcontrol`, store configuration under `/etc/kidcontrol`, and run the service as the dedicated `kidcontrol` user.

### 1. Install Node.js, npm, and Git

The commands below install the tested official Node.js `22.22.3` x86-64 archive under `/usr/local/lib/nodejs`. The download is about 31 MB and is verified against Node.js's published SHA-256 file.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git xz-utils
cd /tmp
curl -fsSLO https://nodejs.org/dist/v22.22.3/node-v22.22.3-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v22.22.3/SHASUMS256.txt
grep ' node-v22.22.3-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -
sudo install -d -m 0755 /usr/local/lib/nodejs
sudo tar -xJf node-v22.22.3-linux-x64.tar.xz -C /usr/local/lib/nodejs
sudo ln -sfn /usr/local/lib/nodejs/node-v22.22.3-linux-x64/bin/node /usr/local/bin/node
sudo ln -sfn /usr/local/lib/nodejs/node-v22.22.3-linux-x64/bin/npm /usr/local/bin/npm
sudo ln -sfn /usr/local/lib/nodejs/node-v22.22.3-linux-x64/bin/npx /usr/local/bin/npx
sudo /usr/local/bin/npm install --global npm@11.18.0
rm node-v22.22.3-linux-x64.tar.xz SHASUMS256.txt
node --version
npm --version
git --version
```

### 2. Clone, build, and test KidControl

Start in the home directory in which the repository should be checked out:

```bash
git clone https://github.com/tseiman/KidControl.git
cd KidControl/code
npm config set allow-git root --location=project
npm ci
npm test
npm run build
npm prune --omit=dev
cd ..
```

The Node.js archive includes npm 10, so the installation upgrades it to the tested npm `11.18.0` before configuring Git-source policy. `node-appletv-remote` is an intentional direct GitHub dependency pinned by `package-lock.json`. `allow-git=root` permits that direct dependency while leaving transitive Git dependencies blocked. The package manifest separately approves only the pinned `node-appletv-remote` `prepare` script and the pinned `esbuild` build-helper script required by the tested build.

### 3. Create the service account and directories

```bash
sudo useradd --system --home-dir /var/lib/kidcontrol --shell /usr/sbin/nologin kidcontrol
sudo install -d -o root -g root -m 0755 /opt/kidcontrol/code
sudo install -d -o kidcontrol -g kidcontrol -m 0700 /etc/kidcontrol
sudo install -d -o root -g kidcontrol -m 0750 /etc/kidcontrol/icons
sudo install -d -o kidcontrol -g kidcontrol -m 0700 /var/lib/kidcontrol
```

### 4. Install the application

```bash
sudo cp -a code/dist code/node_modules code/package.json code/package-lock.json /opt/kidcontrol/code/
sudo chown -R root:root /opt/kidcontrol
```

### 5. Install and edit the protected configuration

```bash
sudo install -o kidcontrol -g kidcontrol -m 0600 config/config.example.json /etc/kidcontrol/config.json
sudo install -o root -g root -m 0600 code/.env.example /etc/kidcontrol/kidcontrol.env
sudo mcedit /etc/kidcontrol/config.json
sudo mcedit /etc/kidcontrol/kidcontrol.env
```

Replace every dummy user, PIN, budget, ACL name, Apple TV identifier, path, origin, site ID, and API key.

Generate the required independent authentication pepper once and copy it into `KIDCONTROL_AUTH_PEPPER` in the protected environment file:

```bash
openssl rand -hex 32
```

Do not commit or share the resulting pepper, UniFi API key, PINs, cookie tokens, or Companion credentials.

#### Optional user avatars

Each regular user or superuser can have an optional portrait in the login tile grid. The superuser target picker additionally shows portraits for its regular-user targets. Add a simple filename to that user's object in `/etc/kidcontrol/config.json`:

```json
{
  "icon": "anna.webp"
}
```

Store the corresponding file outside Git under `/etc/kidcontrol/icons`:

```bash
sudo install -d -o root -g kidcontrol -m 0750 /etc/kidcontrol/icons
sudo install -o root -g kidcontrol -m 0640 /path/to/anna.webp /etc/kidcontrol/icons/anna.webp
```

Accepted filename extensions are `.png`, `.jpg`, `.jpeg`, and `.webp`, and each file may be up to 5 MiB. The value must be a plain filename beginning with a letter or digit; the remaining base-name characters may be letters, digits, dots, underscores, or hyphens. Directory separators, leading dots, SVG extensions, and symlinks are rejected. Administrators must ensure that the file content matches its extension. KidControl serves the image only through the public, unauthenticated `/api/user-icons/<user-id>` route because portraits are required on the login screen. Rectangular images are center-cropped into a circle without modifying the source file; omitted or unreadable images fall back to safe initials. Restart KidControl after changing `config.json`. See the [configuration quick guide](config/README_CONFIGURATION.md#user-icons) for the full rules.

#### Certificate files

If the UniFi controller uses a certificate from a publicly trusted CA and sends its intermediate certificate correctly, leave `UNIFI_CA_FILE` empty. Node.js then uses its normal public trust store.

Only for a private/internal CA, create `/etc/kidcontrol/unifi-ca.pem` with the issuing intermediate CA certificate first and the root CA certificate second. It must contain CA certificates only—no UniFi leaf certificate and no private key:

```bash
sudo mcedit /etc/kidcontrol/unifi-ca.pem
sudo chown kidcontrol:kidcontrol /etc/kidcontrol/unifi-ca.pem
sudo chmod 0600 /etc/kidcontrol/unifi-ca.pem
```

Then set `UNIFI_CA_FILE=/etc/kidcontrol/unifi-ca.pem`.

The HTTPS reverse proxy needs different files: `/etc/nginx/ssl/kidcontrol.fullchain.pem` containing the KidControl host's leaf certificate followed by its intermediate certificate(s), plus the matching private key at `/etc/nginx/ssl/kidcontrol.key`. Do not append the public root certificate to the served full chain. A root and intermediate certificate alone are insufficient; the host-specific leaf certificate and its private key are also required.

```bash
sudo install -d -o root -g root -m 0750 /etc/nginx/ssl
sudo mcedit /etc/nginx/ssl/kidcontrol.fullchain.pem
sudo mcedit /etc/nginx/ssl/kidcontrol.key
sudo chown root:root /etc/nginx/ssl/kidcontrol.fullchain.pem /etc/nginx/ssl/kidcontrol.key
sudo chmod 0644 /etc/nginx/ssl/kidcontrol.fullchain.pem
sudo chmod 0600 /etc/nginx/ssl/kidcontrol.key
```

Reference them in the Nginx TLS server with `ssl_certificate` and `ssl_certificate_key`.

### 6. Pair every Apple TV

Each physical Apple TV requires its own one-time Companion pairing. Keep KidControl stopped and run this command once for each Apple TV:

```bash
sudo -u kidcontrol env HOME=/etc/kidcontrol \
  /opt/kidcontrol/code/node_modules/.bin/atv companion-pair
```

Select exactly one Apple TV and enter the PIN displayed on that device. Repeat the command for every configured Apple TV. The CLI updates `/etc/kidcontrol/.atv-credentials.json` and protects it with mode `0600`. AirPlay pairing with `atv pair` is not required by KidControl.

Copy each credential map's top-level device ID into the matching `appleTvIdentifier` in `/etc/kidcontrol/config.json`. This identifier often looks like a MAC address such as `AA:BB:CC:DD:EE:FF`; it is not the Apple TV name such as `Wohnzimmer`. Do not guess it from UniFi Ethernet or Wi-Fi addresses—copy the exact, case-sensitive top-level key written by `companion-pair`. The [configuration quick guide](config/README_CONFIGURATION.md) includes a safe command that prints only these IDs and a read-only power-state verification.

The HTTPS reverse proxy must preserve the public host and overwrite the client address with exactly one value:

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-For $remote_addr;
```

Set `TRUSTED_PROXY_IP` to the proxy address as seen by KidControl. `PUBLIC_ORIGIN` and `UNIFI_HOST` must both use HTTPS.

### 7. Install and start the systemd service

The checked-in unit is [`etc/kidcontrol.service`](etc/kidcontrol.service).

```bash
sudo install -o root -g root -m 0644 etc/kidcontrol.service /etc/systemd/system/kidcontrol.service
sudo systemctl daemon-reload
sudo systemctl enable --now kidcontrol.service
sudo systemctl status --no-pager kidcontrol.service
```

The unit sends application stdout, stderr, structured operational events, and systemd lifecycle messages to the standard systemd journal. KidControl does not create or use separate files under `/var/log/kidcontrol`.

Follow application output and errors with timestamps using:

```bash
sudo journalctl -u kidcontrol.service -f -o short-iso-precise
```

The first application line after every process start is the Git revision embedded during the build, for example `KidControl version 27b6a88`. A `-dirty` suffix means the build contained local changes that were not committed; `unknown` means `dist/version.txt` was not installed. Neither state is expected for a normal production update.

The service binds to `127.0.0.1:8080` by default. Expose it only through the configured HTTPS reverse proxy.

## Updating KidControl

Run the checked-in update script from the repository root. It supports being run directly as `root`; on a multi-user installation it can also run as the checkout user and request `sudo` for protected deployment steps.

```bash
cd ~/KidControl
./update.sh
```

The script checks the clean `main` checkout, Node.js version, active service, protected configuration/state paths, and systemd unit. It then pulls with `--ff-only`, installs dependencies, runs all tests, builds, audits production dependencies, verifies the embedded revision, and prunes development dependencies before it stops the service.

After confirmation, it replaces only `/opt/kidcontrol/code/dist` and `/opt/kidcontrol/code/node_modules`, installs the package files and systemd unit, restarts KidControl, and checks both the active service and matching revision in the journal for the current systemd invocation. It does not modify `/etc/kidcontrol` or `/var/lib/kidcontrol`. If an install command fails after the stop, it attempts to start the service again.

To skip only the final confirmation, use:

```bash
./update.sh --yes
```

All safety, build, test, and revision checks still run.

### Manual update fallback

The equivalent manual procedure remains available for recovery or diagnosis. The first status command must produce no output. If it lists local changes, resolve them before continuing; do not overwrite them with an update.

```bash
cd ~/KidControl
git status --short
git pull --ff-only
cd code
npm config set allow-git root --location=project
npm ci
npm test
npm run build
npm prune --omit=dev
cd ..
```

Only after the new revision has built and passed all tests, stop the service and install it.

**The following removal is intentionally limited to generated application code and dependencies under `/opt/kidcontrol/code`. It does not remove `/etc/kidcontrol` configuration, Apple TV credentials, or `/var/lib/kidcontrol` SQLite state.**

```bash
sudo systemctl stop kidcontrol.service
sudo rm -rf /opt/kidcontrol/code/dist /opt/kidcontrol/code/node_modules
sudo cp -a code/dist code/node_modules code/package.json code/package-lock.json /opt/kidcontrol/code/
sudo chown -R root:root /opt/kidcontrol
sudo install -o root -g root -m 0644 etc/kidcontrol.service /etc/systemd/system/kidcontrol.service
sudo systemctl daemon-reload
sudo systemctl start kidcontrol.service
sudo systemctl status --no-pager kidcontrol.service
sudo journalctl -u kidcontrol.service -n 50 --no-pager -o short-iso-precise
```

Confirm that the current startup output contains `KidControl version` followed by the short revision just pulled and that the same revision appears below the **Documentation** link in the WebUI. This proves that systemd and the browser loaded the newly built application rather than an older `/opt/kidcontrol` copy. If only the browser still shows old assets, perform a hard reload; favicons and Apple home-screen icons may remain cached separately.

Do not replace `/etc/kidcontrol/config.json`, `/etc/kidcontrol/kidcontrol.env`, `/etc/kidcontrol/.atv-credentials.json`, `/etc/kidcontrol/icons`, or `/var/lib/kidcontrol/state.sqlite` during a normal update. Review new example files in Git manually if a release documents a configuration change.

## Safety semantics

- A regular user can start only while the latest authoritative Apple TV state is exactly `on`; `off` and `unknown` disable Start and are rejected by the server. Superusers can deliberately override all three states.
- Only confirmed Companion `Asleep → off` ends normal regular-user claims.
- `on`, `unknown`, disconnects, and network errors never fabricate standby.
- Wake does not start or resume a claim.
- Active claims are conservatively charged through downtime until restart or exact budget exhaustion.
- External UniFi changes are adopted during normal reconciliation.
- An external no-claim allowance remains the baseline until an explicit superuser restore.
- A failed first unblock does not start billable usage.
- Removing a device that may still be allowed or pending deliberately blocks startup until it is safely restored with the previous configuration.

## License

[MIT](LICENSE)
