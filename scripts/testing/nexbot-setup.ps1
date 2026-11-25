# Exercises the installer and its per-user registry entries on a disposable runner.
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This check requires a disposable GitHub-hosted Windows VM.'
}
$packages = @(Get-ChildItem release/personal-client/*-Client-Setup.exe)
if ($packages.Count -ne 1) { throw 'Expected exactly one Setup package.' }
$setup = $packages[0]
$version = [regex]::Match($setup.Name, '^NexBot-(\d+\.\d+\.\d+)-x64-Client-Setup\.exe$').Groups[1].Value
if (!$version) { throw 'Unexpected Setup name.' }

function Install-Candidate([string]$directory) {
    $process = Start-Process $setup.FullName -ArgumentList ('/S /D=' + $directory) -PassThru
    if (!$process.WaitForExit(180000)) { throw 'Setup did not finish.' }
    return $process.ExitCode
}

$occupied = New-Item -ItemType Directory (Join-Path $env:RUNNER_TEMP 'Nonempty target')
$marker = Join-Path $occupied 'keep.txt'
Set-Content $marker 'fixture'
if ((Install-Candidate $occupied.FullName) -eq 0 -or (Get-Content $marker) -ne 'fixture' -or @(Get-ChildItem $occupied).Count -ne 1) {
    throw 'Setup did not preserve a nonempty target.'
}

$target = Join-Path $env:RUNNER_TEMP 'NexBot custom installation'
if ((Install-Candidate $target) -ne 0) { throw 'Custom installation failed.' }
$exe = Get-Item (Join-Path $target 'NexBot Client.exe')
if ($exe.VersionInfo.FileVersion -ne $version -or $exe.VersionInfo.ProductVersion -notin @($version, ($version + '.0'))) {
    throw "Installed version mismatch: $($exe.VersionInfo.FileVersion) / $($exe.VersionInfo.ProductVersion), expected $version."
}
$entry = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
    Where-Object { $_.DisplayName -eq 'NexBot' -and $_.DisplayVersion -eq $version }
if (!$entry) { throw 'Installed apps registration missing.' }
foreach ($folder in 'DesktopDirectory','Programs') {
    if (!(Get-ChildItem ([Environment]::GetFolderPath($folder)) -Recurse -Filter 'NexBot.lnk')) { throw "Missing shortcut in $folder" }
}

$profile = New-Item -Force -ItemType Directory (Join-Path $env:APPDATA 'NexBotClient')
$sentinel = Join-Path $profile 'fixture.txt'
Set-Content $sentinel 'saved'
$alternate = Join-Path $env:RUNNER_TEMP 'Alternate location'
if ((Install-Candidate $alternate) -ne 0 -or (Test-Path $alternate) -or !(Test-Path $exe.FullName) -or (Get-Content $sentinel) -ne 'saved') {
    throw 'Reinstall did not preserve the registered path and profile.'
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureWindow {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
}
'@
$launchProfile = Join-Path $env:RUNNER_TEMP 'nexbot-launch-fixture'
$arg = '--profile="' + $launchProfile + '"'
$first = Start-Process $exe.FullName -ArgumentList $arg -PassThru
try {
    $deadline = (Get-Date).AddSeconds(45)
    while (!$first.MainWindowHandle -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250; $first.Refresh() }
    $handle = $first.MainWindowHandle
    if (!$handle) { throw 'Missing initial client window.' }
    [void][FixtureWindow]::ShowWindow($handle, 6)
    if (![FixtureWindow]::IsIconic($handle)) { throw 'Window did not minimize.' }
    $second = Start-Process $exe.FullName -ArgumentList $arg -PassThru
    if (!$second.WaitForExit(15000)) { throw 'Second launch started another instance.' }
    $deadline = (Get-Date).AddSeconds(15)
    while ([FixtureWindow]::IsIconic($handle) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    $first.Refresh()
    if ($first.HasExited -or [FixtureWindow]::IsIconic($handle)) { throw 'Existing window did not restore.' }
} finally {
    Start-Process $exe.FullName -ArgumentList ($arg + ' --quit') -Wait
    [void]$first.WaitForExit(10000)
}

node scripts/smoke-shell-login.mjs "--exe=$($exe.FullName)"
if ($LASTEXITCODE) { throw 'Installed client smoke failed.' }
Get-FileHash $setup.FullName -Algorithm SHA256
