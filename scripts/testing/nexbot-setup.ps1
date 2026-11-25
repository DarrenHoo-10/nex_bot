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
$reinstallCode = Install-Candidate $alternate
if ($reinstallCode -ne 0) { throw "Reinstall returned $reinstallCode." }
# NSIS may create the command-line /D directory during startup, before it reads the registered path.
if ((Test-Path $alternate) -and @(Get-ChildItem -Force $alternate).Count) { throw 'Setup wrote files into the alternate folder.' }
if (!(Test-Path $exe.FullName)) { throw 'Reinstall removed the registered executable.' }
if (!(Test-Path $sentinel) -or (Get-Content $sentinel) -ne 'saved') { throw 'Reinstall lost the profile marker.' }
$registered = Get-ItemProperty $entry.PSPath
if ($registered.UninstallString -notlike "*$target*") { throw 'Uninstaller no longer points to the registered path.' }

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FixtureWindow {
    private delegate bool Visit(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder name, int size);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
    public static IntPtr Find(uint pid) {
        var result = IntPtr.Zero;
        EnumWindows((handle, ignored) => {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner != pid || !IsWindowVisible(handle)) return true;
            var name = new StringBuilder(256);
            GetClassName(handle, name, name.Capacity);
            if (name.ToString() != "Chrome_WidgetWin_1") return true;
            result = handle;
            return false;
        }, IntPtr.Zero);
        return result;
    }
}
'@
$launchProfile = Join-Path $env:RUNNER_TEMP 'nexbot-launch-fixture'
$arg = '--profile="' + $launchProfile + '"'
$ready = Join-Path $env:RUNNER_TEMP 'nexbot-window-ready.json'
$env:NEX_CLIENT_SMOKE_OUTPUT = $ready
$first = Start-Process $exe.FullName -ArgumentList $arg -PassThru
Remove-Item Env:NEX_CLIENT_SMOKE_OUTPUT
try {
    $deadline = (Get-Date).AddSeconds(45)
    do {
        if ($first.HasExited) { throw 'Initial client exited.' }
        $handle = [FixtureWindow]::Find($first.Id)
        if ($handle -ne [IntPtr]::Zero -and (Test-Path $ready)) { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if ($handle -eq [IntPtr]::Zero -or !(Test-Path $ready)) { throw 'Initial Electron window was not ready.' }
    $deadline = (Get-Date).AddSeconds(10)
    do {
        [void][FixtureWindow]::ShowWindowAsync($handle, 6)
        Start-Sleep -Milliseconds 200
    } while (![FixtureWindow]::IsIconic($handle) -and (Get-Date) -lt $deadline)
    if (![FixtureWindow]::IsIconic($handle)) { throw 'Windows did not minimize the ready Electron window.' }
    $second = Start-Process $exe.FullName -ArgumentList $arg -PassThru
    if (!$second.WaitForExit(15000)) { throw 'Second launch started another instance.' }
    $deadline = (Get-Date).AddSeconds(15)
    while ([FixtureWindow]::IsIconic($handle) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    $first.Refresh()
    if ($first.HasExited -or [FixtureWindow]::Find($first.Id) -ne $handle -or [FixtureWindow]::IsIconic($handle)) { throw 'Existing window did not restore.' }
} finally {
    Start-Process $exe.FullName -ArgumentList ($arg + ' --quit') -Wait
    [void]$first.WaitForExit(10000)
}

node scripts/smoke-release-login.mjs "--exe=$($exe.FullName)"
if ($LASTEXITCODE) { throw 'Installed client smoke failed.' }
Get-FileHash $setup.FullName -Algorithm SHA256
