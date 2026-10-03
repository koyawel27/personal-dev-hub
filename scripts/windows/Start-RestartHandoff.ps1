# Start-RestartHandoff.ps1
# Tiny bootstrap between the Node server and the detached restart handoff.
#
# Why this exists: on Windows, Node cannot spawn a PowerShell process that
# both RUNS and OUTLIVES the server:
#   - spawn detached:true -> DETACHED_PROCESS (no console at all):
#     powershell.exe exits 0 immediately without executing the script.
#   - spawn non-detached  -> PowerShell runs, but is killed shortly after
#     the parent Node process exits, which would abort the handoff before
#     the replacement server is up.
# Start-Process (the same primitive the M1 launcher relies on) creates a
# true orphan that outlives its creator. The bootstrap lives only long
# enough to call Start-Process; the server stays alive until the ready
# file appears, by which time the handoff is already independent.
#
# The only caller-supplied value is the restricted AttemptId. This script
# never touches the database, restore state, or any process.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AttemptId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

# Defense in depth: the handoff re-validates before any filename use.
if ($AttemptId -notmatch '^[A-Za-z0-9_-]+$') {
    [Console]::Error.WriteLine('bootstrap: invalid AttemptId')
    exit 2
}

$handoffScript = Join-Path $scriptDir 'Restart-Handoff.ps1'
if (-not (Test-Path -LiteralPath $handoffScript)) {
    [Console]::Error.WriteLine('bootstrap: handoff script not found')
    exit 3
}

$powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powerShell)) {
    $cmd = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $powerShell = $cmd.Source
    } else {
        [Console]::Error.WriteLine('bootstrap: powershell.exe not found')
        exit 4
    }
}

# Single-string ArgumentList: passed verbatim, avoiding PS 5.1's array
# ArgumentList quoting behavior for paths that contain spaces.
$argString = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -AttemptId {1}' -f $handoffScript, $AttemptId

try {
    Start-Process -FilePath $powerShell -ArgumentList $argString -WindowStyle Hidden | Out-Null
} catch {
    [Console]::Error.WriteLine('bootstrap: Start-Process failed: ' + $_.Exception.Message)
    exit 5
}
exit 0
