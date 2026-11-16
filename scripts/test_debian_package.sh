#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 PACKAGE.deb" >&2; exit 2; }
deb="$(realpath "$1")"
sidecar="${deb}.sha256"
[[ -f "$deb" && -f "$sidecar" ]]
(cd "$(dirname "$deb")" && sha256sum -c "$(basename "$sidecar")")
[[ "$(dpkg-deb -f "$deb" Package)" == kidcontrol ]]
[[ "$(dpkg-deb -f "$deb" Architecture)" == amd64 ]]
[[ "$(dpkg-deb -f "$deb" Version)" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ "$(dpkg-deb -f "$deb" Depends)" == "adduser, systemd, ca-certificates, libc6, libgcc-s1, libstdc++6" ]]
listing="$(dpkg-deb -c "$deb")"
grep -q './usr/lib/kidcontrol/node/bin/node$' <<<"$listing"
grep -q './usr/lib/kidcontrol/code/dist/main.js$' <<<"$listing"
grep -q './usr/lib/kidcontrol/code/node_modules/.bin/atv' <<<"$listing"
grep -q './usr/bin/kidcontrol-atv$' <<<"$listing"
grep -q './lib/systemd/system/kidcontrol.service$' <<<"$listing"
grep -q './usr/share/doc/kidcontrol/NODE-LICENSE$' <<<"$listing"
grep -q './usr/share/doc/kidcontrol/THIRD_PARTY_NOTICES$' <<<"$listing"
! grep -Eq '(\.atv-credentials\.json|state\.sqlite|/etc/kidcontrol/)' <<<"$listing"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/kidcontrol-package-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
dpkg-deb -x "$deb" "$tmp"
dpkg-deb -e "$deb" "$tmp/DEBIAN"
[[ "$($tmp/usr/lib/kidcontrol/node/bin/node --version)" == v22.22.3 ]]
grep -q '^ExecStart=/usr/lib/kidcontrol/node/bin/node ' "$tmp/lib/systemd/system/kidcontrol.service"
grep -q '^ProtectSystem=strict$' "$tmp/lib/systemd/system/kidcontrol.service"
grep -q 'node-appletv-remote/dist/cli/index.js' "$tmp/usr/bin/kidcontrol-atv"
grep -q 'remove the source-install unit before installing the Debian package' "$tmp/DEBIAN/preinst"
"$tmp/usr/lib/kidcontrol/node/bin/node" \
  "$tmp/usr/lib/kidcontrol/code/dist/verify-source-maps.mjs" \
  "$tmp/usr/lib/kidcontrol/code/dist"
echo "package inspection passed: $(basename "$deb")"
