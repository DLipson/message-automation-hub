#!/usr/bin/env bash
set -euo pipefail

env_file="${MESSAGE_HUB_CONTROL_ENV_FILE:-/etc/message-automation-hub/control.env}"

if [ ! -r "$env_file" ]; then
  echo "Cannot read ${env_file}. Run with sudo or configure bot control first." >&2
  exit 1
fi

port="$(sed -n 's/^MESSAGE_HUB_BOT_CONTROL_PORT=//p' "$env_file" | tail -n 1)"
token="$(sed -n 's/^MESSAGE_HUB_BOT_CONTROL_TOKEN=//p' "$env_file" | tail -n 1)"
port="${port:-8788}"

if [ -z "$token" ]; then
  echo "MESSAGE_HUB_BOT_CONTROL_TOKEN is missing from ${env_file}." >&2
  exit 1
fi

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "x-bot-control-token: ${token}" \
  "http://127.0.0.1:${port}/pairing-code"
printf '\n'