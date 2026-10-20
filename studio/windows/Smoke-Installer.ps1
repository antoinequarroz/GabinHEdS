#requires -Version 5.1
<#
  Exercise the actual Setup executable on a fresh GitHub Windows runner.
  This creates no recording or live stream and never starts or closes OBS.
  A failed test only cleans up fresh processes whose executable, command line
  and creation time prove that they belong to this installation.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$startedAt = [datetime]::UtcNow
$report = [ordered]@{
    schemaVersion = 1
    startedAtUtc = $startedAt.ToString('o')
    result = 'failed'
    checks = @()
    commands = @()
    cleanup = @()
    limitations = @('No physical cameras, microphones, OBS recording or live stream are exercised by this installer test.')
}
$script:commandNumber = 0
$installAttempted = $false
$testFailure = $null
$installRoot = $null
$userRoot = $null
$script:reportDirectory = $null
$script:utf8 = New-Object Text.UTF8Encoding($false)

function Assert-Smoke {
    param([Parameter(Mandatory = $true)][bool]$Condition,
          [Parameter(Mandatory = $true)][string]$Name)
    if (-not $Condition) { throw "Installer smoke check failed: $Name" }
    $report.checks += $Name
    Write-Host "OK: $Name"
}

function ConvertTo-SmokeNativeArgument {
    param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-SmokeProcess {
    param([Parameter(Mandatory = $true)][string]$FilePath,
          [Parameter(Mandatory = $true)][string[]]$Arguments,
          [Parameter(Mandatory = $true)][string]$Label,
          [int]$TimeoutSeconds = 600,
          [switch]$AllowNonzero)
    $script:commandNumber++
    $baseName = '{0:d2}-{1}' -f $script:commandNumber, $Label
    $stdoutPath = Join-Path $script:reportDirectory ($baseName + '.stdout.log')
    $stderrPath = Join-Path $script:reportDirectory ($baseName + '.stderr.log')
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = ($Arguments | ForEach-Object { ConvertTo-SmokeNativeArgument -Value $_ }) -join ' '
    $info.WorkingDirectory = Split-Path -Parent $FilePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $code = $null
    try {
        if (-not $process.Start()) { throw "$Label did not start." }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            # Only terminate the exact wrapper process created above. Service
            # cleanup below independently verifies each owned child process.
            try { $process.Kill() } catch { Write-Warning "Could not stop timed-out $Label wrapper." }
            throw "$Label exceeded $TimeoutSeconds seconds."
        }
        $code = $process.ExitCode
        if ($stdoutTask.Wait(5000)) {
            [IO.File]::WriteAllText($stdoutPath, $stdoutTask.Result, $script:utf8)
        }
        if ($stderrTask.Wait(5000)) {
            [IO.File]::WriteAllText($stderrPath, $stderrTask.Result, $script:utf8)
        }
        if ($code -ne 0 -and -not $AllowNonzero) {
            throw "$Label exited with code $code. See $stdoutPath and $stderrPath."
        }
        return [int]$code
    } finally {
        $clock.Stop()
        $report.commands += [ordered]@{
            label = $Label; exitCode = $code
            durationSeconds = [Math]::Round($clock.Elapsed.TotalSeconds, 2)
            stdout = $stdoutPath; stderr = $stderrPath
        }
        $process.Dispose()
    }
}

function Get-ObsSnapshot {
    $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'obs64.exe' OR Name = 'obs32.exe'" |
        ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ExecutablePath, $_.CreationDate.ToUniversalTime().ToString('o') } |
        Sort-Object)
    $profile = Join-Path $env:APPDATA 'obs-studio'
    $files = @()
    if (Test-Path -LiteralPath $profile -PathType Container) {
        $files = @(Get-ChildItem -LiteralPath $profile -File -Recurse | Sort-Object FullName | ForEach-Object {
            '{0}|{1}' -f $_.FullName.Substring($profile.Length), (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        })
    }
    # Keep the fingerprint in memory; the report contains no OBS configuration.
    return [pscustomobject]@{ Processes = ($processes -join "`n"); Profile = ($files -join "`n") }
}

function Assert-NoNinoAutostart {
    param([switch]$AllowCompanionStartup)
    $entries = @()
    foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
                            'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce',
                            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
                            'HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce')) {
        $key = Get-Item -LiteralPath $registry -ErrorAction SilentlyContinue
        if ($null -ne $key) {
            foreach ($name in $key.GetValueNames()) {
                $value = [string]$key.GetValue($name)
                if ($name -match '(?i)\bnino\b' -or
                    $value.IndexOf($script:installRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    $entries += "$registry/$name"
                }
            }
        }
    }
    foreach ($folder in @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))) {
        if ($folder -and (Test-Path -LiteralPath $folder -PathType Container)) {
            foreach ($entry in @(Get-ChildItem -LiteralPath $folder -File | Where-Object { $_.Name -match '(?i)nino' })) {
                $expected = Join-Path ([Environment]::GetFolderPath('Startup')) 'Nino - Companion.lnk'
                if ($AllowCompanionStartup -and [string]::Equals($entry.FullName, $expected, [StringComparison]::OrdinalIgnoreCase)) {
                    $shell = New-Object -ComObject WScript.Shell
                    try {
                        $link = $shell.CreateShortcut($entry.FullName)
                        $scriptPath = Join-Path $script:installRoot 'windows/Start-Companion.ps1'
                        $expectedArguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '" -Startup -NoDialogs'
                        $powerShell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
                        Assert-Smoke ([string]::Equals($link.TargetPath, $powerShell, [StringComparison]::OrdinalIgnoreCase) -and
                            $link.Arguments -ceq $expectedArguments -and
                            $link.Description -ceq 'Nino Companion startup (owned by Nino)') 'only the fixed current-user Companion startup helper is registered'
                    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
                } else { $entries += $entry.FullName }
            }
        }
    }
    Assert-Smoke ($entries.Count -eq 0) 'no unexpected Nino automatic startup entry exists'
}

function Get-SmokeService {
    param([Parameter(Mandatory = $true)][ValidateSet('api', 'media')][string]$Service)
    $statePath = Join-Path $script:userRoot ('run/' + $Service + '.json')
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw "$Service process state is absent." }
    $record = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedExecutable = if ($Service -eq 'api') { Join-Path $script:installRoot 'runtime/node/node.exe' }
        else { Join-Path $script:installRoot 'runtime/mediamtx/mediamtx.exe' }
    $expectedAnchor = if ($Service -eq 'api') { Join-Path $script:installRoot 'app/apps/api/src/index.ts' }
        else { Join-Path $script:installRoot 'app/config/mediamtx.yml' }
    $process = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
    $details = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f [int]$record.pid)
    $time = [datetime]::Parse([string]$record.startedAtUtc, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    if ($null -eq $details -or
        -not [string]::Equals([string]$record.installRoot, $script:installRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$record.executablePath, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$record.anchor, $expectedAnchor, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$details.ExecutablePath, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase) -or
        [string]::IsNullOrWhiteSpace([string]$details.CommandLine) -or
        ([string]$details.CommandLine).IndexOf($expectedAnchor, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        [Math]::Abs(($process.StartTime.ToUniversalTime() - $time).TotalSeconds) -gt 1) {
        throw "$Service process identity does not match this fresh installation."
    }
    return [pscustomobject]@{ Process = $process; State = $record }
}

function Wait-SmokePathGone {
    param([Parameter(Mandatory = $true)][string]$Path)
    $deadline = [datetime]::UtcNow.AddSeconds(30)
    while (Test-Path -LiteralPath $Path) {
        if ([datetime]::UtcNow -ge $deadline) { throw "Uninstall did not remove $Path" }
        Start-Sleep -Milliseconds 200
    }
}

function Remove-SmokeOwnedProcesses {
    if (-not $script:installAttempted -or -not $script:installRoot) { return }
    $apiPath = Join-Path $script:installRoot 'runtime/node/node.exe'
    $apiAnchor = Join-Path $script:installRoot 'app/apps/api/src/index.ts'
    $mediaPath = Join-Path $script:installRoot 'runtime/mediamtx/mediamtx.exe'
    $mediaAnchor = Join-Path $script:installRoot 'app/config/mediamtx.yml'
    $userRuntime = [IO.Path]::GetFullPath((Join-Path $script:userRoot 'runtime/ffmpeg')) + '\'
    $candidates = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe' OR Name = 'mediamtx.exe' OR Name = 'ffmpeg.exe' OR Name = 'ffprobe.exe'" -ErrorAction SilentlyContinue)
    foreach ($candidate in $candidates) {
        try {
            $path = [string]$candidate.ExecutablePath
            $command = [string]$candidate.CommandLine
            $owned = ([string]::Equals($path, $apiPath, [StringComparison]::OrdinalIgnoreCase) -and
                $command.IndexOf($apiAnchor, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
                ([string]::Equals($path, $mediaPath, [StringComparison]::OrdinalIgnoreCase) -and
                $command.IndexOf($mediaAnchor, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
                $path.StartsWith($userRuntime, [StringComparison]::OrdinalIgnoreCase)
            if (-not $owned) { continue }
            $process = Get-Process -Id ([int]$candidate.ProcessId) -ErrorAction Stop
            if ($process.StartTime.ToUniversalTime() -lt $script:startedAt.AddSeconds(-1)) { continue }
            # This runner had neither Nino installation nor Nino data before the
            # test. Only these newly installed runtime paths are eligible.
            $process.Kill()
            [void]$process.WaitForExit(10000)
            $report.cleanup += [ordered]@{ pid = [int]$candidate.ProcessId; executable = [IO.Path]::GetFileName($path) }
        } catch { Write-Warning 'Owned smoke process cleanup could not be completed.' }
    }
}

try {
    if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or -not $env:LOCALAPPDATA) {
        throw 'This destructive install/uninstall test is restricted to a fresh GitHub Windows runner.'
    }
    if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
        throw 'Run this smoke test with Windows PowerShell 5.1.'
    }
    $InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
    $ReportPath = [IO.Path]::GetFullPath($ReportPath)
    $script:reportDirectory = Split-Path -Parent $ReportPath
    [void](New-Item -ItemType Directory -Path $script:reportDirectory -Force)
    $script:utf8 = New-Object Text.UTF8Encoding($false)
    $script:installRoot = Join-Path $env:LOCALAPPDATA 'Programs/Nino'
    $script:userRoot = Join-Path $env:LOCALAPPDATA 'Nino'
    Assert-Smoke (-not (Test-Path -LiteralPath $installRoot)) 'installation directory is initially absent'
    Assert-Smoke (-not (Test-Path -LiteralPath $userRoot)) 'user data directory is initially absent'
    $obsBefore = Get-ObsSnapshot
    $report.installerSha256 = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.windowsPowerShell = $PSVersionTable.PSVersion.ToString()
    $report.osBuild = [Environment]::OSVersion.Version.ToString()
    Assert-NoNinoAutostart

    $installAttempted = $true
    $installLog = Join-Path $script:reportDirectory 'setup-install.log'
    [void](Invoke-SmokeProcess -FilePath $InstallerPath -Arguments @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
        '/TASKS=desktopicon,companionstartup', ('/LOG=' + $installLog)) -Label 'install')
    $launcher = Join-Path $installRoot 'windows/Launch-Nino.ps1'
    $node = Join-Path $installRoot 'runtime/node/node.exe'
    $media = Join-Path $installRoot 'runtime/mediamtx/mediamtx.exe'
    foreach ($file in @($launcher, $node, $media,
        (Join-Path $installRoot 'windows/Prepare-Runtime.ps1'),
        (Join-Path $installRoot 'windows/Start-Companion.ps1'),
        (Join-Path $installRoot 'app/apps/web/dist/index.html'),
        (Join-Path $installRoot 'app/docs/guides/nino-installation-salle.pdf'))) {
        Assert-Smoke (Test-Path -LiteralPath $file -PathType Leaf) ('installed ' + $file.Substring($installRoot.Length + 1))
    }
    $foreignData = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Force | Where-Object {
        $_.Extension -in @('.sqlite', '.db', '.mp4', '.mkv') -or $_.Name -match '^\.env(?:\.|$)'
    })
    Assert-Smoke ($foreignData.Count -eq 0) 'installer contains no private database, recording or environment file'
    Assert-Smoke (-not (Test-Path -LiteralPath (Join-Path $installRoot 'runtime/ffmpeg'))) 'installer does not redistribute FFmpeg'
    Assert-Smoke (-not (Test-Path -LiteralPath (Join-Path $userRoot 'data/studio.sqlite'))) 'silent installation does not create or import a database'
    Assert-NoNinoAutostart -AllowCompanionStartup
    $companionStartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Nino - Companion.lnk'
    Assert-Smoke (Test-Path -LiteralPath $companionStartupLink -PathType Leaf) 'selected Companion startup is registered for the current user'
    $companionSettingsPath = Join-Path $userRoot 'companion-settings.json'
    $companionSettingsHash = (Get-FileHash -LiteralPath $companionSettingsPath -Algorithm SHA256).Hash

    $shell = New-Object -ComObject WScript.Shell
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nino'
    $desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Nino + OBS.lnk'
    $startLink = Join-Path $menu 'Nino + OBS.lnk'
    foreach ($shortcutPath in @($desktopLink, $startLink)) {
        Assert-Smoke (Test-Path -LiteralPath $shortcutPath -PathType Leaf) ('shortcut exists: ' + [IO.Path]::GetFileName($shortcutPath))
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $expectedPowerShell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
        Assert-Smoke ([string]::Equals($shortcut.TargetPath, $expectedPowerShell, [StringComparison]::OrdinalIgnoreCase)) 'shortcut targets Windows PowerShell by absolute path'
        Assert-Smoke ($shortcut.Arguments.Contains('-File "' + $launcher + '"')) 'shortcut quotes the installed launcher path'
        Assert-Smoke ([string]::Equals($shortcut.WorkingDirectory, $installRoot, [StringComparison]::OrdinalIgnoreCase)) 'shortcut starts in the installation directory'
    }
    $stopShortcutPath = Join-Path $menu ('Arr' + [char]0x00EA + 'ter Nino.lnk')
    Assert-Smoke (Test-Path -LiteralPath $stopShortcutPath -PathType Leaf) 'safe stop shortcut exists'
    Assert-Smoke ($shell.CreateShortcut($stopShortcutPath).Arguments -match '(?:^|\s)-Stop(?:\s|$)') 'safe stop shortcut passes -Stop'
    Assert-Smoke (Test-Path -LiteralPath (Join-Path $menu 'Guide installation salle.lnk') -PathType Leaf) 'room guide shortcut exists'
    Assert-Smoke (Test-Path -LiteralPath (Join-Path $menu 'Configurer Companion.lnk') -PathType Leaf) 'Companion configuration shortcut exists'
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

    $powerShell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $launchArguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher, '-NoObs', '-NoBrowser', '-NoDialogs')
    [void](Invoke-SmokeProcess -FilePath $powerShell -Arguments $launchArguments -Label 'launch-first' -TimeoutSeconds 600)
    $apiFirst = Get-SmokeService -Service api
    $mediaFirst = Get-SmokeService -Service media
    $report.servicePids = [ordered]@{ api = $apiFirst.Process.Id; media = $mediaFirst.Process.Id }
    $studioResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:4310/api/guest/config' -UseBasicParsing -TimeoutSec 10
    $guestResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:4312/api/guest/config' -UseBasicParsing -TimeoutSec 10
    $mediaResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:9997/v3/paths/list' -UseBasicParsing -TimeoutSec 10
    $studioConfig = $studioResponse.Content | ConvertFrom-Json
    $guestConfig = $guestResponse.Content | ConvertFrom-Json
    $mediaConfig = $mediaResponse.Content | ConvertFrom-Json
    Assert-Smoke ($studioResponse.StatusCode -eq 200 -and $studioConfig.mode -eq 'studio') 'real studio API responds in studio mode'
    Assert-Smoke ($guestResponse.StatusCode -eq 200 -and $guestConfig.mode -eq 'guest') 'real guest API responds in guest mode'
    Assert-Smoke ($mediaResponse.StatusCode -eq 200 -and $null -ne $mediaConfig.PSObject.Properties['items'] -and
        $null -ne $mediaConfig.PSObject.Properties['itemCount']) 'real MediaMTX HTTP API responds'
    $web = Invoke-WebRequest -Uri 'http://127.0.0.1:4310/' -UseBasicParsing -TimeoutSec 10
    Assert-Smoke ($web.StatusCode -eq 200 -and $web.Content -match '<title>Nino') 'compiled Nino interface is served'
    $database = Join-Path $userRoot 'data/studio.sqlite'
    Assert-Smoke (Test-Path -LiteralPath $database -PathType Leaf) 'database is created in the persistent user data directory'
    Assert-Smoke (-not (Test-Path -LiteralPath (Join-Path $installRoot 'app/.data'))) 'application directory receives no runtime database'
    $cachedFfmpeg = Join-Path $userRoot 'runtime/ffmpeg/9.0.2/bin/ffmpeg.exe'
    $cachedFfprobe = Join-Path $userRoot 'runtime/ffmpeg/9.0.2/bin/ffprobe.exe'
    Assert-Smoke ((Test-Path -LiteralPath $cachedFfmpeg -PathType Leaf) -and
        (Test-Path -LiteralPath $cachedFfprobe -PathType Leaf)) 'first launch downloaded the real FFmpeg and ffprobe runtimes'
    [void](Invoke-SmokeProcess -FilePath $cachedFfmpeg -Arguments @('-version') -Label 'ffmpeg-version' -TimeoutSeconds 30)
    [void](Invoke-SmokeProcess -FilePath $cachedFfprobe -Arguments @('-version') -Label 'ffprobe-version' -TimeoutSeconds 30)

    $settingsPath = Join-Path $userRoot 'settings.json'
    [IO.File]::WriteAllText($settingsPath, '{"listenOnLan":false,"obsPath":null}', $script:utf8)
    $settingsHash = (Get-FileHash -LiteralPath $settingsPath -Algorithm SHA256).Hash
    [void](Invoke-SmokeProcess -FilePath $powerShell -Arguments $launchArguments -Label 'launch-second' -TimeoutSeconds 120)
    $apiSecond = Get-SmokeService -Service api
    $mediaSecond = Get-SmokeService -Service media
    Assert-Smoke ($apiSecond.Process.Id -eq $apiFirst.Process.Id -and $mediaSecond.Process.Id -eq $mediaFirst.Process.Id -and
        $apiSecond.State.startedAtUtc -ceq $apiFirst.State.startedAtUtc -and
        $mediaSecond.State.startedAtUtc -ceq $mediaFirst.State.startedAtUtc) 'second launch reuses both verified service PIDs'
    Assert-NoNinoAutostart -AllowCompanionStartup

    $uninstallers = @(Get-ChildItem -LiteralPath $installRoot -Filter 'unins*.exe' -File)
    Assert-Smoke ($uninstallers.Count -eq 1) 'one registered uninstaller exists'
    $uninstaller = $uninstallers[0].FullName
    $blockedLog = Join-Path $script:reportDirectory 'setup-uninstall-blocked.log'
    $blockedCode = Invoke-SmokeProcess -FilePath $uninstaller -Arguments @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
        ('/LOG=' + $blockedLog)) -Label 'uninstall-active' -TimeoutSeconds 90 -AllowNonzero
    Assert-Smoke ($blockedCode -ne 0) 'uninstall refuses to remove active studio components'
    Assert-Smoke ((Test-Path -LiteralPath $launcher -PathType Leaf) -and (Test-Path -LiteralPath $node -PathType Leaf)) 'refused uninstall leaves application files intact'
    Assert-Smoke ((Get-SmokeService -Service api).Process.Id -eq $apiFirst.Process.Id -and
        (Get-SmokeService -Service media).Process.Id -eq $mediaFirst.Process.Id) 'refused uninstall leaves both services running'

    $sentinel = Join-Path $userRoot 'data/installer-smoke-keep.txt'
    $sentinelValue = 'preserve-' + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($sentinel, $sentinelValue, $script:utf8)
    [void](Invoke-SmokeProcess -FilePath $powerShell -Arguments @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $launcher, '-Stop', '-NoObs', '-NoBrowser', '-NoDialogs') -Label 'stop-idle' -TimeoutSeconds 90)
    $apiFirst.Process.Refresh()
    $mediaFirst.Process.Refresh()
    Assert-Smoke ($apiFirst.Process.HasExited -and $mediaFirst.Process.HasExited) 'safe stop exits the actual API and media processes'
    $obsAfterStop = Get-ObsSnapshot
    Assert-Smoke ($obsBefore.Processes -ceq $obsAfterStop.Processes -and $obsBefore.Profile -ceq $obsAfterStop.Profile) 'OBS processes and profile remain unchanged'
    $databaseHash = (Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash
    $ffmpegHash = (Get-FileHash -LiteralPath $cachedFfmpeg -Algorithm SHA256).Hash
    $ffprobeHash = (Get-FileHash -LiteralPath $cachedFfprobe -Algorithm SHA256).Hash
    $uninstallLog = Join-Path $script:reportDirectory 'setup-uninstall.log'
    [void](Invoke-SmokeProcess -FilePath $uninstaller -Arguments @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
        ('/LOG=' + $uninstallLog)) -Label 'uninstall-idle' -TimeoutSeconds 120)
    Wait-SmokePathGone -Path $launcher
    Wait-SmokePathGone -Path $node
    Wait-SmokePathGone -Path (Join-Path $installRoot 'app')
    Assert-Smoke (-not (Test-Path -LiteralPath $desktopLink) -and -not (Test-Path -LiteralPath $startLink)) 'uninstall removes its desktop and start menu shortcuts'
    Assert-Smoke (-not (Test-Path -LiteralPath $companionStartupLink)) 'uninstall removes only its verified Companion startup link'
    Assert-Smoke ([IO.File]::ReadAllText($sentinel) -ceq $sentinelValue) 'uninstall preserves the user production sentinel'
    Assert-Smoke ((Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash -ceq $databaseHash) 'uninstall preserves the production database unchanged'
    Assert-Smoke ((Get-FileHash -LiteralPath $settingsPath -Algorithm SHA256).Hash -ceq $settingsHash) 'uninstall preserves user settings unchanged'
    Assert-Smoke ((Get-FileHash -LiteralPath $companionSettingsPath -Algorithm SHA256).Hash -ceq $companionSettingsHash) 'uninstall preserves Companion preferences unchanged'
    Assert-Smoke ((Get-FileHash -LiteralPath $cachedFfmpeg -Algorithm SHA256).Hash -ceq $ffmpegHash -and
        (Get-FileHash -LiteralPath $cachedFfprobe -Algorithm SHA256).Hash -ceq $ffprobeHash) 'uninstall preserves downloaded FFmpeg and ffprobe unchanged'
    Assert-Smoke (Test-Path -LiteralPath (Join-Path $userRoot 'logs') -PathType Container) 'uninstall preserves diagnostics'
    Assert-NoNinoAutostart
    $obsAfter = Get-ObsSnapshot
    Assert-Smoke ($obsBefore.Processes -ceq $obsAfter.Processes -and $obsBefore.Profile -ceq $obsAfter.Profile) 'OBS remains untouched after uninstall'
    $report.result = 'passed'
} catch {
    $testFailure = $_.Exception.Message
    $report.error = $testFailure
    Write-Warning $testFailure
} finally {
    if ($null -ne $testFailure) { Remove-SmokeOwnedProcesses }
    $report.completedAtUtc = [datetime]::UtcNow.ToString('o')
    $report.durationSeconds = [Math]::Round(([datetime]::UtcNow - $startedAt).TotalSeconds, 2)
    if ($ReportPath -and $script:reportDirectory -and (Test-Path -LiteralPath $script:reportDirectory)) {
        [IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    }
}

if ($null -ne $testFailure) { exit 1 }
Write-Host ("Installer smoke passed: {0} checks. Report: {1}" -f $report.checks.Count, $ReportPath)
exit 0
