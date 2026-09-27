#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SERVICE="kidcontrol.service"
DATABASE_PATH="/var/lib/kidcontrol/state.sqlite"

usage() {
  cat <<'EOF'
Usage: sudo ./unlock-login.sh

Remove all active KidControl login-throttle records from the canonical
production database. User accounts, PINs, sessions, usage, claims, and device
state are not changed.
EOF
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  '') ;;
  *) usage >&2; die "Unknown argument: $1" ;;
esac

(( EUID != 0 )) && die "Run this administrator script as root: sudo ./unlock-login.sh"

for command in systemctl runuser node realpath stat; do
  command -v "$command" >/dev/null 2>&1 || die "Required command not found: $command"
done

systemctl is-active --quiet "$SERVICE" || die "$SERVICE is not active."
SERVICE_USER=$(systemctl show --property=User --value "$SERVICE")
[[ "$SERVICE_USER" == kidcontrol ]] || die "$SERVICE must run as the dedicated kidcontrol user."

[[ -f "$DATABASE_PATH" ]] || die "Missing production database: $DATABASE_PATH"
CANONICAL_PATH=$(realpath --canonicalize-existing -- "$DATABASE_PATH")
[[ "$CANONICAL_PATH" == "$DATABASE_PATH" ]] || die "Database path contains a symbolic-link component: $DATABASE_PATH"
DATABASE_OWNER=$(stat --format='%U' "$DATABASE_PATH")
[[ "$DATABASE_OWNER" == "$SERVICE_USER" ]] || die "Database owner $DATABASE_OWNER does not match service user $SERVICE_USER."

printf 'Removing all KidControl login throttles from %s as %s...\n' "$DATABASE_PATH" "$SERVICE_USER"
(
  cd /
  runuser --user "$SERVICE_USER" -- /usr/bin/env \
    PATH=/usr/local/bin:/usr/bin:/bin \
    NODE_NO_WARNINGS=1 \
    KIDCONTROL_DB="$DATABASE_PATH" \
    node --experimental-sqlite --input-type=module - "$DATABASE_PATH" <<'NODE'
import { DatabaseSync } from 'node:sqlite';

const databasePath = process.env.KIDCONTROL_DB;
if (databasePath !== process.argv[2]) {
  throw new Error('Refusing unexpected KIDCONTROL_DB path');
}

const database = new DatabaseSync(databasePath);
database.exec('PRAGMA busy_timeout=5000');
try {
  database.exec('BEGIN IMMEDIATE');
  try {
    const version = database.prepare('SELECT version FROM schema_version').get();
    if (Number(version?.version) !== 1) throw new Error('Unexpected KidControl schema version');

    const columns = database.prepare('PRAGMA table_info(auth_attempts)').all()
      .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
    const expectedColumns = [
      { name: 'dimension', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'key', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'attempted_at', type: 'INTEGER', notnull: 1, pk: 0 }
    ];
    if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
      throw new Error('Unexpected auth_attempts schema');
    }

    const triggers = Number(database.prepare(
      "SELECT COUNT(*) count FROM sqlite_schema WHERE type='trigger' AND tbl_name='auth_attempts'"
    ).get().count);
    if (triggers !== 0) throw new Error('Refusing auth_attempts table with triggers');

    const before = Number(database.prepare('SELECT COUNT(*) count FROM auth_attempts').get().count);
    database.exec('DELETE FROM auth_attempts');
    const remaining = Number(database.prepare('SELECT COUNT(*) count FROM auth_attempts').get().count);
    database.exec('COMMIT');
    console.log(`Removed ${before - remaining} login throttle record(s); ${remaining} remain.`);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
} finally {
  database.close();
}
NODE
)
