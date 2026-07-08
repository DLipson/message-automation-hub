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
    [int]$Seconds = 30,
    [string]$ErrorLog
  )

  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalPort -Port $Port) {
      return
    }

    Start-Sleep -Milliseconds 500
  }

  if ($ErrorLog -and (Test-Path $ErrorLog)) {
    $details = Get-Content -Path $ErrorLog -Raw
    if ($details) {
      throw "Timed out waiting for localhost:$Port. Last tunnel error output:`n$details"
    }
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
  $info.EnvironmentVariables.Remove("CLOUDSDK_PYTHON") | Out-Null
  $info.EnvironmentVariables.Remove("CLOUDSDK_PYTHON_SITEPACKAGES") | Out-Null

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

function Get-GcloudPath {
  $sdk = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk"
  $gcloudCmd = Join-Path $sdk "bin\gcloud.cmd"

  if (Test-Path $gcloudCmd) {
    return $gcloudCmd
  }

  $gcloudCommand = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
  if ($gcloudCommand) {
    return $gcloudCommand.Source
  }

  $gcloudCommand = Get-Command gcloud -ErrorAction SilentlyContinue
  if ($gcloudCommand) {
    return $gcloudCommand.Source
  }

  throw "Could not find gcloud. Install Google Cloud CLI for Windows."
}

function Invoke-Gcloud {
  param([string[]]$Arguments)

  $gcloud = Get-GcloudPath
  $oldPython = $env:CLOUDSDK_PYTHON
  $oldSitePackages = $env:CLOUDSDK_PYTHON_SITEPACKAGES
  Remove-Item Env:CLOUDSDK_PYTHON -ErrorAction SilentlyContinue
  Remove-Item Env:CLOUDSDK_PYTHON_SITEPACKAGES -ErrorAction SilentlyContinue

  try {
    & $gcloud @Arguments
  } finally {
    if ($null -ne $oldPython) {
      $env:CLOUDSDK_PYTHON = $oldPython
    }
    if ($null -ne $oldSitePackages) {
      $env:CLOUDSDK_PYTHON_SITEPACKAGES = $oldSitePackages
    }
  }
}

function Get-OpenSshPath {
  $ssh = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"
  if (Test-Path $ssh) {
    return $ssh
  }

  $sshCommand = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if ($sshCommand) {
    return $sshCommand.Source
  }

  throw "Could not find ssh.exe. Install the Windows OpenSSH Client optional feature."
}

function Ensure-SshKey {
  param(
    [string]$KeyPath,
    [string]$Comment = "message-hub-vm"
  )

  $keyDir = Split-Path -Parent $KeyPath
  if (-not (Test-Path $keyDir)) {
    New-Item -ItemType Directory -Path $keyDir -Force | Out-Null
  }

  if (-not (Test-Path $KeyPath)) {
    & (Join-Path $env:WINDIR "System32\OpenSSH\ssh-keygen.exe") `
      -t ed25519 `
      -N "" `
      -f $KeyPath `
      -C $Comment | Out-Null
    Write-Host "Created SSH key: $KeyPath"
  }

  $publicKeyPath = "$KeyPath.pub"
  if (-not (Test-Path $publicKeyPath)) {
    & (Join-Path $env:WINDIR "System32\OpenSSH\ssh-keygen.exe") -y -f $KeyPath |
      Set-Content -Path $publicKeyPath -Encoding ascii
  }

  return $publicKeyPath
}

function Add-OsLoginSshKey {
  param(
    [string]$ProjectId,
    [string]$PublicKeyPath,
    [string]$Ttl = "168h"
  )

  Invoke-Gcloud @(
    "compute", "os-login", "ssh-keys", "add",
    "--project", $ProjectId,
    "--key-file", $PublicKeyPath,
    "--ttl", $Ttl
  ) | Out-Null
}

function Get-OsLoginUser {
  param(
    [string]$ProjectId,
    [string]$VmUser
  )

  if ($VmUser) {
    return $VmUser
  }

  $user = Invoke-Gcloud @(
    "compute", "os-login", "describe-profile",
    "--project", $ProjectId,
    "--format=value(posixAccounts[0].username)"
  )

  $user = ($user | Select-Object -First 1).Trim()
  if (-not $user) {
    throw "Could not determine OS Login username. Pass -VmUser explicitly."
  }

  return $user
}

function Start-IapSshTunnel {
  param(
    [string]$ProjectId,
    [string]$Zone,
    [string]$Instance,
    [int]$SshPort,
    [string]$LogDir
  )

  if (Test-LocalPort -Port $SshPort) {
    Write-Host "IAP SSH tunnel already available on localhost:$SshPort."
    return $null
  }

  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
  $iapOut = Join-Path $LogDir "iap-tunnel.out.log"
  $iapErr = Join-Path $LogDir "iap-tunnel.err.log"
  foreach ($logPath in @($iapOut, $iapErr)) {
    if (Test-Path -LiteralPath $logPath) {
      Remove-Item -LiteralPath $logPath -Force
    }
  }

  $process = Start-Detached `
    -FilePath (Get-GcloudPath) `
    -Arguments @(
      "compute",
      "start-iap-tunnel",
      $Instance,
      "22",
      "--zone", $Zone,
      "--project", $ProjectId,
      "--local-host-port=127.0.0.1:$SshPort"
    ) `
    -StdOut $iapOut `
    -StdErr $iapErr

  Wait-LocalPort -Port $SshPort -Seconds 45 -ErrorLog $iapErr
  Write-Host "IAP SSH tunnel started on localhost:$SshPort (PID $($process.Id))."
  return $process
}

function Invoke-VmCommand {
  param(
    [string]$ProjectId,
    [string]$Zone,
    [string]$Instance,
    [string]$VmUser,
    [int]$SshPort,
    [string]$KeyPath,
    [string]$Command,
    [string]$LogDir
  )

  $publicKeyPath = Ensure-SshKey -KeyPath $KeyPath -Comment "$Instance-iap"
  Add-OsLoginSshKey -ProjectId $ProjectId -PublicKeyPath $publicKeyPath
  $resolvedUser = Get-OsLoginUser -ProjectId $ProjectId -VmUser $VmUser
  Start-IapSshTunnel -ProjectId $ProjectId -Zone $Zone -Instance $Instance -SshPort $SshPort -LogDir $LogDir | Out-Null

  $normalizedCommand = $Command -replace "`r`n", "`n" -replace "`r", ""

  & (Get-OpenSshPath) `
    -p $SshPort `
    -i $KeyPath `
    -o StrictHostKeyChecking=accept-new `
    -o HostKeyAlias="$Instance-iap" `
    -o ServerAliveInterval=30 `
    "$resolvedUser@127.0.0.1" `
    $normalizedCommand
}

function Start-VmLocalForward {
  param(
    [string]$ProjectId,
    [string]$Zone,
    [string]$Instance,
    [string]$VmUser,
    [int]$SshPort,
    [string]$KeyPath,
    [int]$LocalPort,
    [int]$RemotePort,
    [string]$LogDir
  )

  if (Test-LocalPort -Port $LocalPort) {
    Write-Host "Local tunnel already available on localhost:$LocalPort."
    return $null
  }

  $publicKeyPath = Ensure-SshKey -KeyPath $KeyPath -Comment "$Instance-iap"
  Add-OsLoginSshKey -ProjectId $ProjectId -PublicKeyPath $publicKeyPath
  $resolvedUser = Get-OsLoginUser -ProjectId $ProjectId -VmUser $VmUser
  Start-IapSshTunnel -ProjectId $ProjectId -Zone $Zone -Instance $Instance -SshPort $SshPort -LogDir $LogDir | Out-Null

  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
  $forwardOut = Join-Path $LogDir "port-$LocalPort-forward.out.log"
  $forwardErr = Join-Path $LogDir "port-$LocalPort-forward.err.log"
  foreach ($logPath in @($forwardOut, $forwardErr)) {
    if (Test-Path -LiteralPath $logPath) {
      Remove-Item -LiteralPath $logPath -Force
    }
  }

  $process = Start-Detached `
    -FilePath (Get-OpenSshPath) `
    -Arguments @(
      "-p", "$SshPort",
      "-i", $KeyPath,
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "HostKeyAlias=$Instance-iap",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-N",
      "-L", "$LocalPort`:127.0.0.1:$RemotePort",
      "$resolvedUser@127.0.0.1"
    ) `
    -StdOut $forwardOut `
    -StdErr $forwardErr

  Wait-LocalPort -Port $LocalPort -Seconds 20 -ErrorLog $forwardErr
  Write-Host "Local tunnel started on localhost:$LocalPort (PID $($process.Id))."
  return $process
}
