param(
  [string]$ProjectId = "project-f57c5350-09b6-46d6-957",
  [string]$Zone = "us-central1-a",
  [string]$Instance = "message-hub-2",
  [string]$VmUser = "",
  [int]$SshPort = 2222,
  [int]$GuiPort = 8787,
  [string]$KeyPath = "$env:USERPROFILE\.ssh\google_compute_engine",
  [switch]$Open
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\vm-common.ps1"

$logDir = Join-Path (Join-Path $env:LOCALAPPDATA "Temp") "message-automation-hub"

$settingsSetup = @'
sudo bash -lc 'set -euo pipefail
service="message-hub-settings"
drop_dir="/etc/systemd/system/${service}.service.d"
drop_file="${drop_dir}/vm-config.conf"
install -d -m 0755 "$drop_dir"
printf "%s\n" \
  "[Service]" \
  "User=opc" \
  "Group=opc" \
  "Environment=NODE_ENV=production" \
  "Environment=MESSAGE_HUB_SETTINGS_PORT=8787" \
  "Environment=MESSAGE_HUB_ENV_FILE=/home/opc/secrets/message-automation-hub/.env" \
  "Environment=MESSAGE_HUB_SECRET_STORE=file" \
  "Environment=MESSAGE_HUB_SECRET_FILE=/home/opc/secrets/message-automation-hub/secrets.json" \
  > "$drop_file"
systemctl daemon-reload
systemctl restart "$service"
sleep 4
journalctl -u "$service" --no-pager -n 40 -l
'
'@

$journal = Invoke-VmCommand `
  -ProjectId $ProjectId `
  -Zone $Zone `
  -Instance $Instance `
  -VmUser $VmUser `
  -SshPort $SshPort `
  -KeyPath $KeyPath `
  -Command $settingsSetup `
  -LogDir $logDir

$journalText = $journal -join "`n"
$urlMatches = [regex]::Matches($journalText, "http://127\.0\.0\.1:$GuiPort/\?token=[a-f0-9]+")
if ($urlMatches.Count -eq 0) {
  Write-Host $journalText
  throw "Could not find a settings GUI URL in the service logs."
}

$url = $urlMatches[$urlMatches.Count - 1].Value

Start-VmLocalForward `
  -ProjectId $ProjectId `
  -Zone $Zone `
  -Instance $Instance `
  -VmUser $VmUser `
  -SshPort $SshPort `
  -KeyPath $KeyPath `
  -LocalPort $GuiPort `
  -RemotePort $GuiPort `
  -LogDir $logDir | Out-Null

Write-Host ""
Write-Host "Open:"
Write-Host $url
Write-Host ""
Write-Host "The settings service is configured to write /home/opc/secrets/message-automation-hub/.env."
Write-Host "After saving settings, restart the bot with: sudo systemctl restart message-automation-hub"

if ($Open) {
  Start-Process $url
}
