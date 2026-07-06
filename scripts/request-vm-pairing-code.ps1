param(
  [string]$ProjectId = "project-f57c5350-09b6-46d6-957",
  [string]$Zone = "us-central1-a",
  [string]$Instance = "message-hub-2",
  [string]$VmUser = "dovid",
  [int]$SshPort = 2222,
  [string]$KeyPath = "$env:USERPROFILE\.ssh\message_hub_gce"
)

$ErrorActionPreference = "Stop"

function Test-LocalPort {
  param([int]$Port)

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(500)) {
      return $false
    }

    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-LocalPort {
  param(
    [int]$Port,
    [int]$Seconds = 30
  )

  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalPort -Port $Port) {
      return
    }

    Start-Sleep -Milliseconds 500
  }

  throw "Timed out waiting for localhost:$Port"
}

function Join-ProcessArguments {
  param([string[]]$Arguments)

  return (($Arguments | ForEach-Object {
    if ($_ -eq "") {
      '""'
    } elseif ($_ -notmatch '[\s"]') {
      $_
    } else {
      '"' + ($_ -replace '"', '\"') + '"'
    }
  }) -join ' ')
}

function Start-Detached {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$StdOut,
    [string]$StdErr
  )

  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $FilePath
  $info.Arguments = Join-ProcessArguments -Arguments $Arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $info
  [void]$process.Start()

  Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -Action {
    if ($EventArgs.Data) {
      Add-Content -Path $Event.MessageData.StdOut -Value $EventArgs.Data
    }
  } -MessageData @{ StdOut = $StdOut } | Out-Null

  Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -Action {
    if ($EventArgs.Data) {
      Add-Content -Path $Event.MessageData.StdErr -Value $EventArgs.Data
    }
  } -MessageData @{ StdErr = $StdErr } | Out-Null

  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()
  return $process
}

function Get-GcloudInvocation {
  $sdk = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk"
  $python = Join-Path $sdk "platform\bundledpython\python.exe"
  $gcloud = Join-Path $sdk "lib\gcloud.py"

  if ((Test-Path $python) -and (Test-Path $gcloud)) {
    return @{
      FilePath = $python
      Prefix = @($gcloud)
    }
  }

  $gcloudCommand = Get-Command gcloud -ErrorAction SilentlyContinue
  if ($gcloudCommand) {
    return @{
      FilePath = $gcloudCommand.Source
      Prefix = @()
    }
  }

  throw "Could not find gcloud. Install Google Cloud CLI or set up the bundled SDK path."
}

function Invoke-Remote {
  param([string]$Command)

  & "$env:WINDIR\System32\OpenSSH\ssh.exe" `
    -p $SshPort `
    -i $KeyPath `
    -o StrictHostKeyChecking=accept-new `
    -o HostKeyAlias="$Instance-iap" `
    "$VmUser@127.0.0.1" `
    $Command
}

if (-not (Test-Path $KeyPath)) {
  throw "SSH key not found: $KeyPath"
}

$logDir = Join-Path $env:TEMP "message-automation-hub"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

if (-not (Test-LocalPort -Port $SshPort)) {
  $gcloudInvocation = Get-GcloudInvocation
  $iapOut = Join-Path $logDir "iap-tunnel.out.log"
  $iapErr = Join-Path $logDir "iap-tunnel.err.log"
  Remove-Item $iapOut, $iapErr -ErrorAction SilentlyContinue

  $iapArgs = @(
    $gcloudInvocation.Prefix
    "compute"
    "start-iap-tunnel"
    $Instance
    "22"
    "--zone"
    $Zone
    "--project"
    $ProjectId
    "--local-host-port=127.0.0.1:$SshPort"
  )

  $iapProcess = Start-Detached `
    -FilePath $gcloudInvocation.FilePath `
    -Arguments $iapArgs `
    -StdOut $iapOut `
    -StdErr $iapErr

  Wait-LocalPort -Port $SshPort -Seconds 30
  Write-Host "IAP SSH tunnel started on localhost:$SshPort (PID $($iapProcess.Id))."
}

Invoke-Remote "sudo /opt/message-automation-hub/scripts/request-pairing-code.sh"