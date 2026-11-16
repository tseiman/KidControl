# <img src="code/public/apple-touch-icon.png" alt="KidControl icon" width="36" height="36" align="top"> KidControl

## Table of contents

- [Documentation](#documentation)
- [System requirements summary](#system-requirements-summary)
- [Status](#status)
- [Default installation](#default-installation)
- [Updating KidControl](#updating-kidcontrol)
- [Source installation alternative](#source-installation-alternative)
- [Clearing login throttles](#clearing-login-throttles)
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
- **Software:** x86-64 Debian 12/13, systemd, and an HTTPS reverse proxy; the package bundles Node.js
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

The recommended installation is the signed APT package for x86-64 Debian 12
(Bookworm) or Debian 13 (Trixie). The package includes the official Node.js
22.22.3 x64 runtime, so a system Node.js or npm installation is not required.

### 1. Register the signed repository

Download the key and verify its fingerprint before installing it. Stop if the
fingerprint differs from `FBB4 E68D ABB4 A25F 6E73 C81D D4EA 266E 8BC8 043F`.

```bash
curl --fail --location --output apt-repo.asc https://tseiman.github.io/apt-repro/apt-repo.asc
gpg --show-keys --fingerprint apt-repo.asc
```

Set the suite to `bookworm` on Debian 12 or `trixie` on Debian 13:

```bash
. /etc/os-release
case "$VERSION_CODENAME" in bookworm|trixie) suite="$VERSION_CODENAME" ;; *) echo "Unsupported Debian release" >&2; exit 1 ;; esac
sudo install -d -m 0755 /etc/apt/keyrings
sudo install -m 0644 apt-repo.asc /etc/apt/keyrings/tseiman-apt-repro.asc
printf 'Types: deb\nURIs: https://tseiman.github.io/apt-repro/\nSuites: %s\nComponents: main\nSigned-By: /etc/apt/keyrings/tseiman-apt-repro.asc\n' "$suite" | sudo tee /etc/apt/sources.list.d/tseiman-apt-repro.sources >/dev/null
sudo apt-get update
apt-cache policy kidcontrol
sudo apt-get install kidcontrol
```

Installation creates protected defaults only when they are missing. It does not
enable, start, or restart `kidcontrol.service`.

### 2. Configure and pair

Edit `/etc/kidcontrol/config.json` and `/etc/kidcontrol/kidcontrol.env`; replace
every example value. See the [configuration guide](config/README_CONFIGURATION.md)
for the schema, proxy/TLS contract, icons, and certificate handling.

```bash
sudo mcedit /etc/kidcontrol/config.json
sudo mcedit /etc/kidcontrol/kidcontrol.env
```

With the service stopped, pair each physical Apple TV separately:

```bash
sudo -u kidcontrol env HOME=/etc/kidcontrol \
  /usr/bin/kidcontrol-atv companion-pair
```

The CLI preserves all paired devices in
`/etc/kidcontrol/.atv-credentials.json`. Copy each exact top-level device ID to
its `appleTvIdentifier`; do not substitute the display name or guess a network
address.

### 3. Enable and verify

Only after configuration and pairing are complete:

```bash
sudo systemctl enable --now kidcontrol.service
sudo systemctl status --no-pager kidcontrol.service
sudo journalctl -u kidcontrol.service -n 50 --no-pager -o short-iso-precise
```

The service binds to `127.0.0.1:8080` by default and must be exposed only through
the configured HTTPS reverse proxy. Logs go only to the systemd journal.

## Updating KidControl

```bash
sudo apt-get update
apt-cache policy kidcontrol
sudo apt-get install --only-upgrade kidcontrol
sudo systemctl restart kidcontrol.service
sudo systemctl status --no-pager kidcontrol.service
```

Upgrades preserve `/etc/kidcontrol` (including configuration, environment,
Apple TV credentials, CA files, and icons) and `/var/lib/kidcontrol` (including
the SQLite database). Package installation deliberately leaves an already
running service on its current process until the operator validates the update
and restarts it.

## Source installation alternative

Developers may still build from Git using Node.js `>=22.12.0`, `npm ci`,
`npm test`, and `npm run build`. The legacy source deployment uses
`/opt/kidcontrol`; package deployments use `/usr/lib/kidcontrol` and the packaged
unit. **Do not mix source and package layouts or copy the source unit over the
package unit.** Choose one installation method. Existing source operators should
stop the service, remove any full unit override under `/etc/systemd/system`, and
then install/configure the package before enabling it. The source-only update
script remains available for installations that intentionally stay on the Git
layout.

## Clearing login throttles

Five failed sign-in attempts within 15 minutes temporarily block the affected user and source address. The WebUI distinguishes this HTTP `429` response from an incorrect user/PIN response and shows a live `MM:SS` countdown based on the server's `Retry-After` header.

An administrator with SSH and root access can remove all login-throttle records before they expire:

```bash
cd ~/KidControl
sudo ./unlock-login.sh
```

The script accepts only the canonical production path `/var/lib/kidcontrol/state.sqlite`, rejects symbolic-link path components, requires the active systemd service to run as `kidcontrol`, verifies the database owner, schema version, exact `auth_attempts` columns, and absence of triggers, then performs one bounded SQLite transaction as the service user. It deletes only `auth_attempts`; users, PINs, authenticated sessions, usage accounting, claims, and device state remain unchanged. The service stays running and does not need to be restarted. Running the script when no throttle records exist is safe and reports that zero records were removed.

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
