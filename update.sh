#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SERVICE="kidcontrol.service"
INSTALL_ROOT="/opt/kidcontrol/code"
UNIT_SOURCE="etc/kidcontrol.service"
UNIT_TARGET="/etc/systemd/system/kidcontrol.service"
ASSUME_YES=0
SERVICE_STOPPED=0
UPDATE_OK=0

usage() {
  cat <<'EOF'
Usage: ./update.sh [--yes]

Pull, test, build, and install the latest KidControl main revision.

Options:
  --yes   Skip the final confirmation.
  --help  Show this help without changing anything.
EOF
}

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

for argument in "$@"; do
  case "$argument" in
    --yes) ASSUME_YES=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $argument" ;;
  esac
done

restart_after_failure() {
  local status=$?
  if (( status != 0 && SERVICE_STOPPED == 1 && UPDATE_OK == 0 )); then
    printf '\nUpdate failed after the service was stopped; attempting to start it again.\n' >&2
    sudo systemctl start "$SERVICE" || true
  fi
}
trap restart_after_failure EXIT

if (( EUID == 0 )); then
  die "Run this script as the normal checkout user, not with sudo."
fi

for command in git node npm sudo systemctl systemd-analyze journalctl; do
  command -v "$command" >/dev/null 2>&1 || die "Required command not found: $command"
done

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd "$SCRIPT_DIR"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "Not inside a Git checkout."
[[ $(cd "$REPO_ROOT" && pwd -P) == "$SCRIPT_DIR" ]] || die "update.sh must be in the KidControl repository root."
[[ -f code/package-lock.json && -f "$UNIT_SOURCE" ]] || die "Incomplete KidControl checkout."
[[ $(git symbolic-ref --quiet --short HEAD) == main ]] || die "The checked-out branch must be main."
[[ $(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}') == origin/main ]] || die "main must track origin/main."
[[ -z $(git status --porcelain --untracked-files=normal) ]] || die "The working tree is not clean."

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) process.exit(1);
' || die "Node.js >=22.12.0 is required; found $(node --version)."

log "Pulling origin/main"
git pull --ff-only
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] || die "Local main does not match origin/main."
[[ -z $(git status --porcelain --untracked-files=normal) ]] || die "The working tree became dirty after pull."
REVISION=$(git rev-parse --short=7 HEAD)

log "Checking production prerequisites"
sudo -v
sudo test -d "$INSTALL_ROOT" || die "Missing $INSTALL_ROOT."
sudo test ! -L "$INSTALL_ROOT" || die "$INSTALL_ROOT must not be a symbolic link."
sudo test -f /etc/kidcontrol/config.json || die "Missing /etc/kidcontrol/config.json."
sudo test -f /etc/kidcontrol/kidcontrol.env || die "Missing /etc/kidcontrol/kidcontrol.env."
sudo test -f /etc/kidcontrol/.atv-credentials.json || die "Missing Apple TV credentials."
sudo test -d /etc/kidcontrol/icons || die "Missing /etc/kidcontrol/icons."
sudo test -d /var/lib/kidcontrol || die "Missing /var/lib/kidcontrol."
sudo systemctl is-active --quiet "$SERVICE" || die "$SERVICE is not active."
systemd-analyze verify "$UNIT_SOURCE"

log "Installing dependencies"
cd code
npm config set allow-git root --location=project
npm ci

log "Running tests"
npm test

log "Building $REVISION"
npm run build

log "Auditing production dependencies"
npm audit --omit=dev

[[ -f dist/version.txt ]] || die "Build did not create dist/version.txt."
BUILT_REVISION=$(tr -d '\r\n' < dist/version.txt)
[[ "$BUILT_REVISION" == "$REVISION" ]] || die "Built revision $BUILT_REVISION does not match $REVISION."
[[ -f dist/main.js && -f dist/public/index.html && -f dist/documentation.md ]] || die "Build output is incomplete."

log "Pruning development dependencies"
npm prune --omit=dev
npm ls --omit=dev --depth=0
cd "$SCRIPT_DIR"
[[ -z $(git status --porcelain --untracked-files=normal) ]] || die "The build left the working tree dirty."

if (( ASSUME_YES == 0 )); then
  [[ -t 0 ]] || die "Use --yes for intentional non-interactive execution."
  read -r -p "Install revision $REVISION and restart $SERVICE? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) printf 'Update cancelled.\n'; exit 0 ;; esac
fi

log "Installing $REVISION"
sudo systemctl stop "$SERVICE"
SERVICE_STOPPED=1
sudo rm -rf -- "$INSTALL_ROOT/dist" "$INSTALL_ROOT/node_modules"
sudo cp -a code/dist code/node_modules code/package.json code/package-lock.json "$INSTALL_ROOT/"
sudo chown -R root:root /opt/kidcontrol
sudo install -o root -g root -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
sudo systemctl daemon-reload
sudo systemctl start "$SERVICE"
SERVICE_STOPPED=0

log "Verifying the update"
sudo systemctl is-active --quiet "$SERVICE" || die "$SERVICE did not become active."
INSTALLED_REVISION=$(tr -d '\r\n' < "$INSTALL_ROOT/dist/version.txt")
[[ "$INSTALLED_REVISION" == "$REVISION" ]] || die "Installed revision does not match $REVISION."
JOURNAL=$(sudo journalctl -u "$SERVICE" -n 100 --no-pager -o cat)
[[ "$JOURNAL" == *"KidControl version $REVISION"* ]] || die "Journal does not contain KidControl version $REVISION."

UPDATE_OK=1
log "Update completed successfully: $REVISION"
sudo systemctl status --no-pager "$SERVICE"
sudo journalctl -u "$SERVICE" -n 20 --no-pager
