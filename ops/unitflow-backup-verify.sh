#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BACKUP_ROOT="${UNITFLOW_BACKUP_ROOT:-/var/backups/unitflow}"
KEY_FILE="${UNITFLOW_BACKUP_KEY_FILE:-/etc/unitflow/backup.key}"
LATEST="$(find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'unitflow-*.tar.enc' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
test -n "$LATEST" || { echo "No UnitFlow backup found" >&2; exit 1; }
sha256sum --check "${LATEST}.sha256"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf -- "$WORK_DIR"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:${KEY_FILE}" -in "$LATEST" |
  tar -C "$WORK_DIR" -xf -
pg_restore --list "$WORK_DIR/platform.dump" >/dev/null
pg_restore --list "$WORK_DIR/core.dump" >/dev/null
echo "UnitFlow backup verification passed"
