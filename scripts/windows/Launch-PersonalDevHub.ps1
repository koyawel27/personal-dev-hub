# Launch-PersonalDevHub.ps1
# Windows one-click launcher for Personal Dev Hub (source checkout + Node).
# Starts the production server quietly if needed, waits for real health, opens the browser.
# Does not package the app, install dependencies, or manage Git repositories.

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Show-ErrorBox {
    param([string]$Message)
    try {
        Add-Type -AssemblyName System.Windows.Forms | Out-Null
        [System.Windows.Forms.MessageBox]::Show(
            $Message,
            'Personal Dev Hub',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } catch {
        Write-Error $Message
    }
}

function Get-HealthResult {
    # Returns @{ Healthy = $bool; PortOpen = $bool }
    $result = @{ Healthy = $false; PortOpen = $false }

    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $tcp.BeginConnect('127.0.0.1', 8787, $null, $null)
        $result.PortOpen = $iar.AsyncWaitHandle.WaitOne(500)
        if ($result.PortOpen) {
            try { $tcp.EndConnect($iar) } catch { $result.PortOpen = $false }
        }
    } catch {
        $result.PortOpen = $false
    } finally {
        try { $tcp.Close() } catch { }
    }

    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/health' -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200) {
            $json = $response.Content | ConvertFrom-Json
            if ($json -and $json.ok -eq $true) {
                $result.Healthy = $true
            }
        }
    } catch {
        $result.Healthy = $false
    }

    return $result
}

function Open-AppBrowser {
    Start-Process 'http://127.0.0.1:8787'
}

# --- Resolve repository root from this script (scripts/windows -> root) ---
$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$repoRoot = [System.IO.Path]::GetFullPath($repoRoot)

$packageJson = Join-Path $repoRoot 'package.json'
if (-not (Test-Path -LiteralPath $packageJson)) {
    Show-ErrorBox "Personal Dev Hub repository root not found from:`n$repoRoot`n`nExpected package.json next to the project root."
    exit 1
}

# --- 1) Already running and healthy? ---
$health = Get-HealthResult
if ($health.Healthy) {
    Open-AppBrowser
    exit 0
}

if ($health.PortOpen -and -not $health.Healthy) {
    Show-ErrorBox (
        "Port 8787 appears to be in use by another process.`n`n" +
        "http://127.0.0.1:8787/api/health did not confirm Personal Dev Hub.`n" +
        "This launcher will not stop or replace that process.`n`n" +
        "Close the other application, or free port 8787, then try again."
    )
    exit 1
}

# --- 2) Prerequisites ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Show-ErrorBox "Node.js was not found on PATH.`n`nInstall Node.js 24.19+ from https://nodejs.org/ and try again."
    exit 1
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    Show-ErrorBox "npm.cmd was not found on PATH.`n`nInstall Node.js 24.19+ (includes npm) and try again."
    exit 1
}

$nodeModules = Join-Path $repoRoot 'node_modules'
$hasStartDeps = (Test-Path -LiteralPath $nodeModules) -and (Test-Path -LiteralPath (Join-Path $nodeModules 'tsx'))
if (-not $hasStartDeps) {
    Show-ErrorBox (
        "Project dependencies are not installed.`n`n" +
        "Run npm install from the repository first:`n" +
        "  $repoRoot`n`n" +
        "Then use the Personal Dev Hub shortcut again."
    )
    exit 1
}

# --- 3) Production client build (create only if missing) ---
$clientIndex = Join-Path $repoRoot (Join-Path 'dist' (Join-Path 'client' 'index.html'))
if (-not (Test-Path -LiteralPath $clientIndex)) {
    $buildOut = Join-Path $repoRoot (Join-Path 'data' (Join-Path 'launcher' 'build-out.log'))
    $buildErr = Join-Path $repoRoot (Join-Path 'data' (Join-Path 'launcher' 'build-error.log'))
    $launcherDir = Split-Path -Parent $buildOut
    if (-not (Test-Path -LiteralPath $launcherDir)) {
        New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    }

    $build = Start-Process -FilePath $npm.Source -ArgumentList @('run', 'build') `
        -WorkingDirectory $repoRoot -Wait -PassThru -NoNewWindow `
        -RedirectStandardOutput $buildOut -RedirectStandardError $buildErr

    if ($build.ExitCode -ne 0) {
        Show-ErrorBox (
            "Production client build failed (npm run build).`n`n" +
            "See logs:`n  $buildOut`n  $buildErr"
        )
        exit 1
    }

    if (-not (Test-Path -LiteralPath $clientIndex)) {
        Show-ErrorBox (
            "Build finished but dist\client\index.html is still missing.`n`n" +
            "See logs:`n  $buildOut`n  $buildErr"
        )
        exit 1
    }
}

# --- 4) Start production server quietly ---
$logDir = Join-Path $repoRoot (Join-Path 'data' 'launcher')
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$serverOut = Join-Path $logDir 'server-out.log'
$serverErr = Join-Path $logDir 'server-error.log'

# Hidden cmd wrapper with shell redirection is the most reliable PS 5.1
# path for a quiet `npm start` that still captures logs (no Invoke-Expression).
$cmdLine = '/c npm start 1>"{0}" 2>"{1}"' -f $serverOut, $serverErr

try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine `
        -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
} catch {
    Show-ErrorBox (
        "Could not start Personal Dev Hub (npm start).`n`n" +
        "$($_.Exception.Message)`n`n" +
        "Logs (if any):`n  $serverOut`n  $serverErr"
    )
    exit 1
}

# --- 5) Wait for real readiness ---
$deadline = (Get-Date).AddSeconds(25)
$ready = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $health = Get-HealthResult
    if ($health.Healthy) {
        $ready = $true
        break
    }
}

if ($ready) {
    Open-AppBrowser
    exit 0
}

Show-ErrorBox (
    "Personal Dev Hub did not become healthy on http://127.0.0.1:8787/api/health`n" +
    "within 25 seconds.`n`n" +
    "The server may still be starting, or startup may have failed (including`n" +
    "restore startup blocks). Check logs:`n" +
    "  $serverOut`n  $serverErr`n`n" +
    "The browser was not opened."
)
exit 1
