# Install-PersonalDevHubShortcut.ps1
# Creates a Desktop shortcut named "Personal Dev Hub" that launches
# Launch-PersonalDevHub.ps1 from THIS checkout. The generated .lnk is
# machine-local and is not meant to be committed.

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

function Show-InfoBox {
    param([string]$Message)
    try {
        Add-Type -AssemblyName System.Windows.Forms | Out-Null
        [System.Windows.Forms.MessageBox]::Show(
            $Message,
            'Personal Dev Hub',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
    } catch {
        Write-Host $Message
    }
}

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$launchScript = Join-Path $scriptDir 'Launch-PersonalDevHub.ps1'
if (-not (Test-Path -LiteralPath $launchScript)) {
    Show-ErrorBox "Launcher script not found:`n$launchScript"
    exit 1
}

# Repository root: scripts/windows -> ..
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$repoRoot = [System.IO.Path]::GetFullPath($repoRoot)

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) {
    Show-ErrorBox 'Could not resolve the Desktop folder for this user.'
    exit 1
}

$shortcutPath = Join-Path $desktop 'Personal Dev Hub.lnk'

# Shortcut target: Windows PowerShell, no profile, hidden window.
# -ExecutionPolicy Bypass applies only to this shortcut process, not machine policy.
$powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powerShell)) {
    $cmd = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $powerShell = $cmd.Source
    } else {
        Show-ErrorBox 'Windows PowerShell (powershell.exe) was not found.'
        exit 1
    }
}

$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $launchScript

try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powerShell
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.Description = 'Start Personal Dev Hub and open http://127.0.0.1:8787'
    $shortcut.Save()
} catch {
    Show-ErrorBox (
        "Could not create the Desktop shortcut.`n`n" +
        "$($_.Exception.Message)`n`n" +
        "Target (if created) would be:`n$shortcutPath"
    )
    exit 1
}

Show-InfoBox (
    "Desktop shortcut created:`n$shortcutPath`n`n" +
    "Double-click Personal Dev Hub on the Desktop to start the app and open`n" +
    "http://127.0.0.1:8787`n`n" +
    "Launcher script:`n$launchScript"
)
exit 0
