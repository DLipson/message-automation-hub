param(
  [string]$ProjectId = "project-f57c5350-09b6-46d6-957",
  [string]$Zone = "us-central1-a",
  [string]$Instance = "message-hub-2",
  [string]$VmUser = "",
  [int]$SshPort = 2222,
  [string]$KeyPath = "$env:USERPROFILE\.ssh\google_compute_engine"
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\vm-common.ps1"

$logDir = Join-Path (Join-Path $env:LOCALAPPDATA "Temp") "message-automation-hub"

Invoke-VmCommand `
  -ProjectId $ProjectId `
  -Zone $Zone `
  -Instance $Instance `
  -VmUser $VmUser `
  -SshPort $SshPort `
  -KeyPath $KeyPath `
  -Command "sudo /opt/message-automation-hub/scripts/request-pairing-code.sh" `
  -LogDir $logDir
