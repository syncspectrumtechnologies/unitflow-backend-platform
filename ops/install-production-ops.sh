#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$1"
install -d -m 700 /etc/unitflow /var/backups/unitflow
if [[ ! -s /etc/unitflow/backup.key ]]; then
  openssl rand -base64 48 > /etc/unitflow/backup.key
  chmod 600 /etc/unitflow/backup.key
fi
install -m 750 "${SOURCE_DIR}/unitflow-backup.sh" /usr/local/sbin/unitflow-backup
install -m 750 "${SOURCE_DIR}/unitflow-backup-verify.sh" /usr/local/sbin/unitflow-backup-verify
install -m 755 "${SOURCE_DIR}/unitflow-health-monitor.sh" /usr/local/bin/unitflow-health-monitor
install -m 644 "${SOURCE_DIR}/send-monitor-alert.js" /usr/local/lib/unitflow-send-monitor-alert.js

cat > /etc/systemd/system/unitflow-backup.service <<'UNIT'
[Unit]
Description=UnitFlow encrypted PostgreSQL backup
After=postgresql.service

[Service]
Type=oneshot
EnvironmentFile=/var/www/unitflow-backend-platform/shared/.env
EnvironmentFile=/var/www/unitflow-backend-core/shared/.env
ExecStart=/usr/local/sbin/unitflow-backup
PrivateTmp=true
ProtectHome=true
NoNewPrivileges=true
UNIT

cat > /etc/systemd/system/unitflow-backup.timer <<'UNIT'
[Unit]
Description=Nightly UnitFlow backup

[Timer]
OnCalendar=*-*-* 02:15:00 UTC
Persistent=true
RandomizedDelaySec=900

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/unitflow-backup-verify.service <<'UNIT'
[Unit]
Description=Verify latest encrypted UnitFlow backup

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/unitflow-backup-verify
PrivateTmp=true
ProtectHome=true
NoNewPrivileges=true
UNIT

cat > /etc/systemd/system/unitflow-backup-verify.timer <<'UNIT'
[Unit]
Description=Weekly UnitFlow backup verification

[Timer]
OnCalendar=Sun *-*-* 03:15:00 UTC
Persistent=true
RandomizedDelaySec=900

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/unitflow-health-monitor.service <<'UNIT'
[Unit]
Description=UnitFlow public endpoint and process health check

[Service]
Type=oneshot
User=deploy
Environment=PM2_HOME=/home/deploy/.pm2
Environment=UNITFLOW_PLATFORM_DIR=/var/www/unitflow-backend-platform/current
Environment=UNITFLOW_MONITOR_STATE_DIR=/var/www/unitflow-backend-platform/logs
EnvironmentFile=/var/www/unitflow-backend-platform/shared/.env
ExecStart=/usr/local/bin/unitflow-health-monitor
UNIT

cat > /etc/systemd/system/unitflow-health-monitor.timer <<'UNIT'
[Unit]
Description=Run UnitFlow health checks every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now unitflow-backup.timer unitflow-backup-verify.timer unitflow-health-monitor.timer
