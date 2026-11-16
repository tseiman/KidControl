#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(CDPATH= cd "$SCRIPT_DIR/.." && pwd -P)"
CODE_DIR="$PROJECT_ROOT/code"
OUTPUT_DIR="${PACKAGE_OUTPUT_DIR:-$PROJECT_ROOT}"
NODE_VERSION="22.22.3"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
STAGE_DIR=""
DEPS_DIR=""
DOWNLOAD_DIR=""

log() { printf '[package] %s\n' "$*"; }
die() { printf '[package] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() {
  [[ -z "$STAGE_DIR" || ! -d "$STAGE_DIR" ]] || rm -rf "$STAGE_DIR"
  [[ -z "$DEPS_DIR" || ! -d "$DEPS_DIR" ]] || rm -rf "$DEPS_DIR"
  [[ -z "$DOWNLOAD_DIR" || ! -d "$DOWNLOAD_DIR" ]] || rm -rf "$DOWNLOAD_DIR"
}
trap cleanup EXIT

validate_version() {
  [[ "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "version must be an exact canonical vX.Y.Z release tag"
  printf '%s\n' "${1#v}"
}

require_tracked_source_unchanged() {
  current_state="$(git -C "$PROJECT_ROOT" diff --binary HEAD -- | git hash-object --stdin)"
  [[ "$current_state" == "$TRACKED_STATE_BEFORE" ]] || die "tracked source changed during package gates"
}

if [[ "${1:-}" == "--validate-version" ]]; then
  [[ $# -eq 2 ]] || die "usage: $0 --validate-version vX.Y.Z"
  validate_version "$2"
  exit 0
fi
[[ $# -eq 1 ]] || die "usage: $0 amd64"
[[ "$1" == "amd64" ]] || die "unsupported architecture: $1 (first release supports amd64 only)"

for command in curl dpkg-deb git install npm sha256sum tar xz; do
  command -v "$command" >/dev/null 2>&1 || die "required command not found: $command"
done

if [[ -n "${PACKAGE_VERSION_OVERRIDE:-}" ]]; then
  [[ "${PACKAGE_TEST_MODE:-0}" == "1" ]] || die "PACKAGE_VERSION_OVERRIDE is allowed only with PACKAGE_TEST_MODE=1"
  TAG="$PACKAGE_VERSION_OVERRIDE"
else
  TAG="$(git -C "$PROJECT_ROOT" describe --tags --exact-match HEAD 2>/dev/null)" || die "release builds require HEAD at an exact version tag"
fi
VERSION="$(validate_version "$TAG")"

if [[ "${PACKAGE_ALLOW_DIRTY:-0}" != "1" ]]; then
  [[ -z "$(git -C "$PROJECT_ROOT" status --porcelain --untracked-files=normal)" ]] || die "release builds require a clean worktree"
elif [[ "${PACKAGE_TEST_MODE:-0}" != "1" ]]; then
  die "PACKAGE_ALLOW_DIRTY is allowed only with PACKAGE_TEST_MODE=1"
fi
TRACKED_STATE_BEFORE="$(git -C "$PROJECT_ROOT" diff --binary HEAD -- | git hash-object --stdin)"

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(CDPATH= cd "$OUTPUT_DIR" && pwd -P)"
DEB_PATH="$OUTPUT_DIR/kidcontrol_${VERSION}_amd64.deb"

log "installing and testing the exact source dependency graph"
(
  cd "$CODE_DIR"
  npm config set allow-git root --location=project
  npm ci
  npm test
  npm run build
  npm audit --omit=dev
)
require_tracked_source_unchanged

log "staging production dependencies without pruning the source tree"
DEPS_DIR="$(mktemp -d "${PACKAGE_TMPDIR:-${TMPDIR:-/tmp}}/kidcontrol-deps.XXXXXX")"
install -m 0644 "$CODE_DIR/package.json" "$CODE_DIR/package-lock.json" "$DEPS_DIR/"
(
  cd "$DEPS_DIR"
  npm config set allow-git root --location=project
  npm ci --omit=dev
  npm audit --omit=dev
)

DOWNLOAD_DIR="$(mktemp -d "${PACKAGE_TMPDIR:-${TMPDIR:-/tmp}}/kidcontrol-node.XXXXXX")"
if [[ -n "${PACKAGE_NODE_CACHE_DIR:-}" && -f "$PACKAGE_NODE_CACHE_DIR/$NODE_ARCHIVE" && -f "$PACKAGE_NODE_CACHE_DIR/SHASUMS256.txt" ]]; then
  install -m 0644 "$PACKAGE_NODE_CACHE_DIR/$NODE_ARCHIVE" "$PACKAGE_NODE_CACHE_DIR/SHASUMS256.txt" "$DOWNLOAD_DIR/"
else
  curl --fail --location --retry 3 --output "$DOWNLOAD_DIR/$NODE_ARCHIVE" "$NODE_BASE_URL/$NODE_ARCHIVE"
  curl --fail --location --retry 3 --output "$DOWNLOAD_DIR/SHASUMS256.txt" "$NODE_BASE_URL/SHASUMS256.txt"
fi
(
  cd "$DOWNLOAD_DIR"
  expected="$(grep " ${NODE_ARCHIVE}$" SHASUMS256.txt)"
  [[ -n "$expected" ]] || die "official checksum does not list $NODE_ARCHIVE"
  printf '%s\n' "$expected" | sha256sum -c -
)

STAGE_DIR="$(mktemp -d "${PACKAGE_TMPDIR:-${TMPDIR:-/tmp}}/kidcontrol-deb.XXXXXX")"
chmod 0755 "$STAGE_DIR"
install -d -m 0755 \
  "$STAGE_DIR/DEBIAN" \
  "$STAGE_DIR/usr/lib/kidcontrol/code" \
  "$STAGE_DIR/usr/lib/kidcontrol/node" \
  "$STAGE_DIR/usr/bin" \
  "$STAGE_DIR/usr/share/kidcontrol" \
  "$STAGE_DIR/usr/share/doc/kidcontrol" \
  "$STAGE_DIR/lib/systemd/system"

install -d -m 0755 "$STAGE_DIR/usr/lib/kidcontrol/code/dist"
cp -a "$CODE_DIR/dist/." "$STAGE_DIR/usr/lib/kidcontrol/code/dist/"
cp -a "$DEPS_DIR/node_modules" "$STAGE_DIR/usr/lib/kidcontrol/code/"
install -m 0644 "$CODE_DIR/package.json" "$CODE_DIR/package-lock.json" "$STAGE_DIR/usr/lib/kidcontrol/code/"
tar -xJf "$DOWNLOAD_DIR/$NODE_ARCHIVE" -C "$STAGE_DIR/usr/lib/kidcontrol/node" --strip-components=1
rm -rf \
  "$STAGE_DIR/usr/lib/kidcontrol/node/include" \
  "$STAGE_DIR/usr/lib/kidcontrol/node/lib" \
  "$STAGE_DIR/usr/lib/kidcontrol/node/share" \
  "$STAGE_DIR/usr/lib/kidcontrol/node/CHANGELOG.md" \
  "$STAGE_DIR/usr/lib/kidcontrol/node/README.md" \
  "$STAGE_DIR/usr/lib/kidcontrol/node/bin/corepack" \
  "$STAGE_DIR/usr/lib/kidcontrol/node/bin/npm" \
  "$STAGE_DIR/usr/lib/kidcontrol/node/bin/npx"
install -m 0644 "$PROJECT_ROOT/config/config.example.json" "$STAGE_DIR/usr/share/kidcontrol/config.example.json"
install -m 0644 "$CODE_DIR/.env.example" "$STAGE_DIR/usr/share/kidcontrol/kidcontrol.env.example"
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    WorkingDirectory=*) printf '%s\n' 'WorkingDirectory=/usr/lib/kidcontrol/code' ;;
    Environment=PATH=*) printf '%s\n' 'Environment=PATH=/usr/lib/kidcontrol/node/bin:/usr/bin:/bin' ;;
    ExecStart=*) printf '%s\n' 'ExecStart=/usr/lib/kidcontrol/node/bin/node --enable-source-maps /usr/lib/kidcontrol/code/dist/main.js' ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$PROJECT_ROOT/etc/kidcontrol.service" > "$STAGE_DIR/lib/systemd/system/kidcontrol.service"
chmod 0644 "$STAGE_DIR/lib/systemd/system/kidcontrol.service"
cat > "$STAGE_DIR/usr/bin/kidcontrol-atv" <<'EOF_ATV'
#!/bin/sh
exec /usr/lib/kidcontrol/node/bin/node /usr/lib/kidcontrol/code/node_modules/node-appletv-remote/dist/cli/index.js "$@"
EOF_ATV
chmod 0755 "$STAGE_DIR/usr/bin/kidcontrol-atv"
install -m 0644 "$PROJECT_ROOT/LICENSE" "$STAGE_DIR/usr/share/doc/kidcontrol/copyright"
install -m 0644 "$STAGE_DIR/usr/lib/kidcontrol/node/LICENSE" "$STAGE_DIR/usr/share/doc/kidcontrol/NODE-LICENSE"

"$STAGE_DIR/usr/lib/kidcontrol/node/bin/node" -e '
const fs=require("fs"), path=require("path");
const root=process.argv[1], out=process.argv[2], rows=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){if(e.name.startsWith("."))continue;walk(p)}else if(e.name==="package.json"){try{const j=JSON.parse(fs.readFileSync(p));if(j.name&&j.version)rows.push(`${j.name}@${j.version}: ${j.license||"license in package files"}`)}catch{}}}}
walk(root); fs.writeFileSync(out,"Production npm modules\n======================\n"+[...new Set(rows)].sort().join("\n")+"\n\nLicense files are retained inside each installed npm module.\n");
' "$STAGE_DIR/usr/lib/kidcontrol/code/node_modules" "$STAGE_DIR/usr/share/doc/kidcontrol/THIRD_PARTY_NOTICES"
chmod 0644 "$STAGE_DIR/usr/share/doc/kidcontrol/THIRD_PARTY_NOTICES"

cat > "$STAGE_DIR/DEBIAN/control" <<EOF
Package: kidcontrol
Version: $VERSION
Section: net
Priority: optional
Architecture: amd64
Maintainer: aiAgentTseiman <ai-agent.tseiman@tseiman.de>
Depends: adduser, systemd, ca-certificates, libc6, libgcc-s1, libstdc++6
Installed-Size: $(du -sk "$STAGE_DIR" | cut -f1)
Description: Time-budgeted network access control for Apple TVs
 KidControl coordinates UniFi blocking ACLs and Apple TV Companion state through
 a protected mobile web interface.
EOF
chmod 0644 "$STAGE_DIR/DEBIAN/control"

cat > "$STAGE_DIR/DEBIAN/preinst" <<'EOF'
#!/bin/sh
set -e
if [ -e /etc/systemd/system/kidcontrol.service ] || [ -L /etc/systemd/system/kidcontrol.service ]; then
  echo 'kidcontrol: remove the source-install unit before installing the Debian package: /etc/systemd/system/kidcontrol.service' >&2
  exit 1
fi
exit 0
EOF
chmod 0755 "$STAGE_DIR/DEBIAN/preinst"

cat > "$STAGE_DIR/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
die() { echo "kidcontrol: $*" >&2; exit 1; }
reject_symlink() { [ ! -L "$1" ] || die "refusing symlink: $1"; }
require_directory_or_missing() { reject_symlink "$1"; [ ! -e "$1" ] || [ -d "$1" ] || die "expected directory: $1"; }
install_default_if_missing() {
  source_path="$1"; target_path="$2"; owner="$3"; group="$4"; mode="$5"
  reject_symlink "$source_path"; [ -f "$source_path" ] || die "missing package default: $source_path"
  reject_symlink "$target_path"
  if [ -e "$target_path" ]; then [ -f "$target_path" ] || die "expected regular file: $target_path"; return; fi
  install -o "$owner" -g "$group" -m "$mode" "$source_path" "$target_path"
}
if ! getent group kidcontrol >/dev/null; then addgroup --system kidcontrol; fi
if ! getent passwd kidcontrol >/dev/null; then
  adduser --system --ingroup kidcontrol --home /var/lib/kidcontrol --no-create-home --shell /usr/sbin/nologin kidcontrol
fi
for path in /etc/kidcontrol /etc/kidcontrol/icons /var/lib/kidcontrol; do require_directory_or_missing "$path"; done
install -d -o root -g kidcontrol -m 0750 /etc/kidcontrol /etc/kidcontrol/icons
install -d -o kidcontrol -g kidcontrol -m 0700 /var/lib/kidcontrol
install_default_if_missing /usr/share/kidcontrol/config.example.json /etc/kidcontrol/config.json kidcontrol kidcontrol 0600
install_default_if_missing /usr/share/kidcontrol/kidcontrol.env.example /etc/kidcontrol/kidcontrol.env root root 0600
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || true; fi
exit 0
EOF
chmod 0755 "$STAGE_DIR/DEBIAN/postinst"

cat > "$STAGE_DIR/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
case "${1:-}" in
  remove|deconfigure)
    if command -v systemctl >/dev/null 2>&1; then systemctl stop kidcontrol.service || true; fi
    ;;
esac
exit 0
EOF
chmod 0755 "$STAGE_DIR/DEBIAN/prerm"

cat > "$STAGE_DIR/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
# Site configuration, credentials, icons, and database remain operator-owned even on purge.
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || true; fi
exit 0
EOF
chmod 0755 "$STAGE_DIR/DEBIAN/postrm"

find "$STAGE_DIR/usr" "$STAGE_DIR/lib" -type d -exec chmod 0755 {} +
find "$STAGE_DIR/usr" "$STAGE_DIR/lib" -type f -exec chmod 0644 {} +
chmod 0755 "$STAGE_DIR/usr/lib/kidcontrol/node/bin/node" "$STAGE_DIR/usr/bin/kidcontrol-atv"
find "$STAGE_DIR/usr/lib/kidcontrol/code/node_modules/.bin" -type l -o -type f 2>/dev/null | while IFS= read -r path; do [[ -L "$path" ]] || chmod 0755 "$path"; done
SOURCE_DATE_EPOCH="$(git -C "$PROJECT_ROOT" show -s --format=%ct HEAD)"
export SOURCE_DATE_EPOCH
find "$STAGE_DIR" -print0 | xargs -0 touch --no-dereference --date="@$SOURCE_DATE_EPOCH"
rm -f "$DEB_PATH" "$DEB_PATH.sha256"
dpkg-deb --root-owner-group -Zxz --uniform-compression --build "$STAGE_DIR" "$DEB_PATH" >/dev/null
(cd "$OUTPUT_DIR" && sha256sum "$(basename "$DEB_PATH")" > "$(basename "$DEB_PATH").sha256")
log "created $(basename "$DEB_PATH") and checksum"
