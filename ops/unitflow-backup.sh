#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BACKUP_ROOT="${UNITFLOW_BACKUP_ROOT:-/var/backups/unitflow}"
RETENTION_DAYS="${UNITFLOW_BACKUP_RETENTION_DAYS:-14}"
KEY_FILE="${UNITFLOW_BACKUP_KEY_FILE:-/etc/unitflow/backup.key}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$BACKUP_ROOT"
WORK_DIR="$(mktemp -d "${BACKUP_ROOT}/.work-${STAMP}-XXXX")"
trap 'rm -rf -- "$WORK_DIR"' EXIT
test -s "$KEY_FILE" || { echo "Backup key is missing" >&2; exit 1; }

backup_db() {
  local name="$1" url="$2"
  test -n "$url" || { echo "Database URL for ${name} is missing" >&2; exit 1; }
  # Prisma accepts a schema query parameter that PostgreSQL client tools reject.
  url="$(printf '%s' "$url" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')"
  pg_dump --format=custom --no-owner --no-acl --dbname="$url" --file="${WORK_DIR}/${name}.dump"
  pg_restore --list "${WORK_DIR}/${name}.dump" >/dev/null
}

backup_db platform "$PLATFORM_DATABASE_URL"
backup_db core "$DATABASE_URL"
tar -C "$WORK_DIR" -cf - platform.dump core.dump |
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 250000 -pass "file:${KEY_FILE}" \
    -out "${BACKUP_ROOT}/unitflow-${STAMP}.tar.enc"
sha256sum "${BACKUP_ROOT}/unitflow-${STAMP}.tar.enc" > "${BACKUP_ROOT}/unitflow-${STAMP}.tar.enc.sha256"
find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'unitflow-*.tar.enc*' -mtime "+${RETENTION_DAYS}" -delete

if [[ -n "${UNITFLOW_OFFSITE_COMMAND:-}" ]]; then
  UNITFLOW_BACKUP_FILE="${BACKUP_ROOT}/unitflow-${STAMP}.tar.enc" bash -c "$UNITFLOW_OFFSITE_COMMAND"
fi
echo "UnitFlow encrypted backup completed: ${STAMP}"
