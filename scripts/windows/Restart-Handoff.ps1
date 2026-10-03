# Restart-Handoff.ps1
# Internal detached handoff. Paths are derived from THIS script's location.
# The only caller-supplied value is a restricted AttemptId (no filesystem paths).
# Never kills processes; never touches the database or restore-state files.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AttemptId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-HandoffLog {
    param([string]$Message)
    try {
        if (-not $launcherDir) { return }
        if (-not (Test-Path -LiteralPath $launcherDir)) {
            New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
        }
        $line = '{0} {1}' -f (Get-Date).ToString('o'), $Message
        Add-Content -LiteralPath $handoffLog -Value $line -Encoding UTF8
    } catch { }
}

function Write-ReadyFile {
    try {
        $tmp = "$readyFile.tmp"
        $payload = @{
            ready      = $true
            handoffPid = $PID
            timestamp  = (Get-Date).ToUniversalTime().ToString('o')
        } | ConvertTo-Json
        Set-Content -LiteralPath $tmp -Value $payload -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $readyFile -Force
    } catch {
        Write-HandoffLog "ERROR: failed to write ready file: $($_.Exception.Message)"
    }
}

function Test-Port8787Listening {
    try {
        $lines = & netstat -ano 2>$null | Select-String -Pattern ':8787\s+.*LISTENING'
        return ($null -ne $lines -and @($lines).Count -gt 0)
    } catch {
        return $false
    }
}

# --- Validate AttemptId before any filename use. ---
if ($AttemptId -notmatch '^[A-Za-z0-9_-]+$') {
    [Console]::Error.WriteLine('handoff: invalid AttemptId')
    exit 1
}

# --- Derive ALL filesystem paths from this script (no caller paths). ---
$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir '..\..'))
$launcherScript = Join-Path $scriptDir 'Launch-PersonalDevHub.ps1'
$launcherDir = Join-Path $repositoryRoot (Join-Path 'data' 'launcher')
$handoffLog = Join-Path $launcherDir 'restart-handoff.log'
$readyFile = Join-Path $launcherDir "restart-handoff-ready-$AttemptId.json"

try {
    if (-not (Test-Path -LiteralPath $launcherDir)) {
        New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    }
} catch { }

Write-HandoffLog 'handoff started'
Write-HandoffLog "repository root resolved: $repositoryRoot"

if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'package.json'))) {
    Write-HandoffLog 'ERROR: package.json not found at repository root'
    exit 1
}
if (-not (Test-Path -LiteralPath $launcherScript)) {
    Write-HandoffLog 'ERROR: launcher script not found'
    exit 1
}

# Readiness handshake (script body is running).
Write-ReadyFile
Write-HandoffLog "ready file written: $readyFile"

Write-HandoffLog 'waiting for port 8787 to become free'
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    if (Test-Port8787Listening) {
        Start-Sleep -Milliseconds 250
        continue
    }
    Start-Sleep -Milliseconds 200
    if (-not (Test-Port8787Listening)) {
        break
    }
}

if (Test-Port8787Listening) {
    Write-HandoffLog 'ERROR: port 8787 still listening after wait; not launching'
    exit 2
}
Write-HandoffLog 'port is free'

$powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powerShell)) {
    $cmd = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $powerShell = $cmd.Source
    } else {
        Write-HandoffLog 'ERROR: powershell.exe not found'
        exit 3
    }
}

Write-HandoffLog "invoking launcher: $launcherScript"
try {
    $psiArgs = @(
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', $launcherScript
    )
    $proc = Start-Process -FilePath $powerShell -ArgumentList $psiArgs `
        -WorkingDirectory $repositoryRoot -WindowStyle Hidden -PassThru
    if ($proc -and $proc.Id) {
        Write-HandoffLog "launcher invocation returned (launcher pid $($proc.Id))"
    } else {
        Write-HandoffLog 'launcher invocation returned (no pid)'
    }
    Write-HandoffLog 'handoff complete'
    exit 0
} catch {
    Write-HandoffLog "ERROR: launcher invocation failed: $($_.Exception.Message)"
    exit 4
}
