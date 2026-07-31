#!/usr/bin/env bash
set -euo pipefail

service="${MESSAGE_HUB_SERVICE_NAME:-message-automation-hub}"
config_dir="${MESSAGE_HUB_CONTROL_CONFIG_DIR:-/etc/message-automation-hub}"
env_file="${MESSAGE_HUB_CONTROL_ENV_FILE:-${config_dir}/control.env}"
drop_in_dir="/etc/systemd/system/${service}.service.d"
drop_in_file="${drop_in_dir}/control.conf"
port="${MESSAGE_HUB_BOT_CONTROL_PORT:-8788}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo so it can write ${env_file} and the systemd drop-in." >&2
  exit 1
fi

install -d -m 0700 -o root -g root "$config_dir"

if [ -f "$env_file" ]; then
  chmod 0600 "$env_file"
  chown root:root "$env_file"
else
  token="$(openssl rand -hex 24)"
  umask 077
  cat >"$env_file" <<EOF
MESSAGE_HUB_BOT_CONTROL_PORT=${port}
MESSAGE_HUB_BOT_CONTROL_TOKEN=${token}
EOF
fi

if ! grep -q '^MESSAGE_HUB_BOT_CONTROL_PORT=' "$env_file"; then
  printf '\nMESSAGE_HUB_BOT_CONTROL_PORT=%s\n' "$port" >>"$env_file"
fi

if ! grep -q '^MESSAGE_HUB_BOT_CONTROL_TOKEN=' "$env_file"; then
  token="$(openssl rand -hex 24)"
  printf 'MESSAGE_HUB_BOT_CONTROL_TOKEN=%s\n' "$token" >>"$env_file"
fi

install -d -m 0755 -o root -g root "$drop_in_dir"
cat >"$drop_in_file" <<EOF
[Service]
EnvironmentFile=${env_file}
EOF
chmod 0644 "$drop_in_file"

systemctl daemon-reload
systemctl restart "$service"

printf 'Configured %s control endpoint on 127.0.0.1:%s.\n' "$service" "$(sed -n 's/^MESSAGE_HUB_BOT_CONTROL_PORT=//p' "$env_file" | tail -n 1)"
printf 'Use: sudo /opt/message-automation-hub/scripts/request-pairing-code.sh\n'