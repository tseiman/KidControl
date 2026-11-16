#!/bin/bash
set -euo pipefail
[[ $# -eq 1 ]] || exit 2
deb="$1"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq adduser ca-certificates systemd libc6 libgcc-s1 libstdc++6 >/dev/null
dpkg -i "$deb"
test -x /usr/lib/kidcontrol/node/bin/node
test "$(/usr/lib/kidcontrol/node/bin/node --version)" = v22.22.3
test -x /usr/bin/kidcontrol-atv
/usr/bin/kidcontrol-atv --help >/dev/null
test -f /etc/kidcontrol/config.json
test -f /etc/kidcontrol/kidcontrol.env
test "$(stat -c %a /etc/kidcontrol/config.json)" = 600
test "$(stat -c %a /etc/kidcontrol/kidcontrol.env)" = 600
! systemctl is-enabled --quiet kidcontrol.service
! systemctl is-active --quiet kidcontrol.service
systemd-analyze verify /lib/systemd/system/kidcontrol.service
echo local-config > /etc/kidcontrol/config.json
echo credentials > /etc/kidcontrol/.atv-credentials.json
mkdir -p /etc/kidcontrol/icons
echo icon > /etc/kidcontrol/icons/user.webp
echo database > /var/lib/kidcontrol/state.sqlite
dpkg -i "$deb"
grep -qx local-config /etc/kidcontrol/config.json
grep -qx credentials /etc/kidcontrol/.atv-credentials.json
grep -qx icon /etc/kidcontrol/icons/user.webp
grep -qx database /var/lib/kidcontrol/state.sqlite
! systemctl is-enabled --quiet kidcontrol.service
! systemctl is-active --quiet kidcontrol.service
dpkg --remove kidcontrol
test -f /etc/kidcontrol/config.json
test -f /etc/kidcontrol/.atv-credentials.json
test -f /etc/kidcontrol/icons/user.webp
test -f /var/lib/kidcontrol/state.sqlite
dpkg -i "$deb"
grep -qx local-config /etc/kidcontrol/config.json
grep -qx database /var/lib/kidcontrol/state.sqlite
dpkg --remove kidcontrol
mkdir -p /etc/systemd/system
printf '%s\n' '[Unit]' 'Description=legacy source unit' > /etc/systemd/system/kidcontrol.service
if dpkg -i "$deb" > /tmp/kidcontrol-legacy-install.log 2>&1; then
  echo 'install unexpectedly accepted a source-install unit override' >&2
  exit 1
fi
grep -q 'remove the source-install unit before installing the Debian package' /tmp/kidcontrol-legacy-install.log
rm -f /etc/systemd/system/kidcontrol.service /tmp/kidcontrol-legacy-install.log
echo "install lifecycle passed on $(. /etc/os-release; echo "$VERSION_CODENAME")"
