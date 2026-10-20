#requires -Version 5.1
# OS process, HTTP and shortcut-write boundaries are mocked; no app is launched.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../Start-Companion.ps1')
$script:checks = 0
function Assert-Companion {
    param([bool]$Condition, [string]$Message)
    $script:checks++
    if (-not $Condition) { throw "FAILED: $Message" }
}
function Assert-CompanionThrows {
    param([scriptblock]$Action, [string]$Message)
    $thrown = $false
    try { & $Action } catch { $thrown = $true }
    Assert-Companion $thrown $Message
}
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('nino-companion-' + [guid]::NewGuid().ToString('N'))
$originalWindows = $env:WINDIR
[void](New-Item -ItemType Directory -Path $scratch)
try {
    $env:WINDIR = Join-Path $scratch 'Windows'
    $layout = Get-NinoCompanionLayout -LauncherDirectory (Join-Path $scratch 'Nino Salle/windows') `
        -LocalAppData (Join-Path $scratch 'profile') -StartupDirectory (Join-Path $scratch 'Startup')
    Assert-Companion ($layout.SettingsPath -eq (Join-Path $scratch 'profile/Nino/companion-settings.json')) 'Companion settings are separate from studio settings'
    Assert-Companion (-not $layout.SettingsPath.StartsWith($layout.InstallRoot)) 'Companion settings survive application replacement'
    Assert-Companion ($layout.StartupLink -eq (Join-Path $scratch 'Startup/Nino - Companion.lnk')) 'startup is current-user only'
    Assert-Companion ((ConvertTo-NinoCompanionArgument 'C:\Nino Salle\windows\Launch-Nino.ps1') -eq '"C:\Nino Salle\windows\Launch-Nino.ps1"') 'fixed launcher path is quoted'
    Assert-Companion ((ConvertTo-NinoCompanionArgument 'x"y') -eq '"x\"y"') 'native argument quote escaping'

    $settings = Get-NinoCompanionSettings -Path $layout.SettingsPath
    Assert-Companion (-not $settings.StartupEnabled -and $null -eq $settings.ExecutablePath) 'no settings never enables startup by itself'
    Save-NinoCompanionSettings -Path $layout.SettingsPath -ExecutablePath $null -StartupEnabled $true
    $settings = Get-NinoCompanionSettings -Path $layout.SettingsPath
    Assert-Companion ($settings.StartupEnabled -and $null -eq $settings.ExecutablePath) 'installer can enable discovery before Companion is installed'
    $executable = Join-Path $scratch 'Companion/Companion.exe'
    [void](New-Item -ItemType Directory -Path (Split-Path -Parent $executable))
    [IO.File]::WriteAllText($executable, 'fixture, never executed')
    Save-NinoCompanionSettings -Path $layout.SettingsPath -ExecutablePath $executable -StartupEnabled $true
    Assert-Companion ((Get-NinoCompanionSettings -Path $layout.SettingsPath).ExecutablePath -eq $executable) 'explicit installed executable survives settings round trip'
    Assert-CompanionThrows { Resolve-NinoCompanionExecutable -Path 'Companion.exe' } 'relative executable is rejected'
    Assert-CompanionThrows { Resolve-NinoCompanionExecutable -Path (Join-Path $scratch 'powershell.exe') } 'unrelated shell is rejected'
    Assert-CompanionThrows { Resolve-NinoCompanionExecutable -Path ($executable + ' -Command calc') } 'arguments cannot be appended to an executable'
    '{"schemaVersion":1,"startupEnabled":true,"executablePath":null,"arguments":"anything"}' | Set-Content -LiteralPath $layout.SettingsPath -Encoding UTF8
    Assert-CompanionThrows { Get-NinoCompanionSettings -Path $layout.SettingsPath } 'arbitrary command settings are rejected'
    '{"schemaVersion":1,"startupEnabled":"true","executablePath":null}' | Set-Content -LiteralPath $layout.SettingsPath -Encoding UTF8
    Assert-CompanionThrows { Get-NinoCompanionSettings -Path $layout.SettingsPath } 'truthy startup string is rejected'
    '[true]' | Set-Content -LiteralPath $layout.SettingsPath -Encoding UTF8
    Assert-CompanionThrows { Get-NinoCompanionSettings -Path $layout.SettingsPath } 'non-object settings are rejected'

    function Get-NinoCompanionCandidates { return @($script:discoveryPath) }
    $script:discoveryPath = $executable
    Assert-Companion ((Find-NinoCompanionExecutable -ConfiguredPath $null) -eq $executable) 'valid local candidate can be discovered'
    Assert-CompanionThrows { Find-NinoCompanionExecutable -ConfiguredPath (Join-Path $scratch 'Missing/Companion.exe') } 'missing user-selected installation never falls back silently'

    $owned = [pscustomobject]@{ TargetPath = $layout.PowerShellPath;
        Arguments = Get-NinoCompanionStartupArguments -Layout $layout
        WorkingDirectory = $layout.InstallRoot; Description = 'Nino Companion startup (owned by Nino)' }
    Assert-Companion (Test-NinoCompanionOwnedShortcut -Shortcut $owned -Layout $layout) 'all ownership fields identify the startup link'
    $owned.Arguments += ' -Command anything'
    Assert-Companion (-not (Test-NinoCompanionOwnedShortcut -Shortcut $owned -Layout $layout)) 'extra shortcut command loses ownership'
    $owned.Arguments = Get-NinoCompanionStartupArguments -Layout $layout
    function Get-NinoCompanionShortcut { param($Path); return $script:shortcut }
    function Save-NinoCompanionShortcut {
        param($Layout)
        [void](New-Item -ItemType Directory -Path (Split-Path -Parent $Layout.StartupLink) -Force)
        [IO.File]::WriteAllText($Layout.StartupLink, 'owned shortcut fixture')
        $script:shortcutWrites++
    }
    $script:shortcut = $owned
    $script:shortcutWrites = 0
    Set-NinoCompanionStartup -Layout $layout -Enabled $true
    Assert-Companion ($script:shortcutWrites -eq 1 -and (Test-Path -LiteralPath $layout.StartupLink)) 'enable creates only the owned startup link'
    $otherLink = Join-Path (Split-Path -Parent $layout.StartupLink) 'Companion-personal.lnk'
    [IO.File]::WriteAllText($otherLink, 'personal Companion startup')
    $script:shortcut = [pscustomobject]@{ TargetPath = 'foreign.exe'; Arguments = ''; WorkingDirectory = ''; Description = '' }
    Assert-CompanionThrows { Set-NinoCompanionStartup -Layout $layout -Enabled $false } 'disable never removes a foreign same-name shortcut'
    Assert-CompanionThrows { Set-NinoCompanionStartup -Layout $layout -Enabled $true } 'enable never overwrites a foreign same-name shortcut'
    Assert-Companion ([IO.File]::ReadAllText($layout.StartupLink) -eq 'owned shortcut fixture') 'foreign shortcut contents remain intact'
    $script:shortcut = $owned
    Set-NinoCompanionStartup -Layout $layout -Enabled $false
    Assert-Companion (-not (Test-Path -LiteralPath $layout.StartupLink)) 'disable removes the verified owned shortcut'
    Assert-Companion ([IO.File]::ReadAllText($otherLink) -ceq 'personal Companion startup') 'other Companion startup links are untouched'
    Set-NinoCompanionStartup -Layout $layout -Enabled $false
    Assert-Companion $true 'removing an absent owned shortcut is idempotent'

    $script:httpResponse = [pscustomobject]@{ StatusCode = 200; Content = '<html><title>Bitfocus Companion - Admin</title></html>' }
    $script:httpRequests = @()
    function Invoke-WebRequest {
        param($Uri, [switch]$UseBasicParsing, $TimeoutSec, $MaximumRedirection, $ErrorAction)
        $script:httpRequests += $Uri
        if ($script:httpResponse -is [Exception]) { throw $script:httpResponse }
        return $script:httpResponse
    }
    Assert-Companion (Test-NinoCompanionHttpHealth) 'real Companion page is required for readiness'
    $script:httpResponse = [pscustomobject]@{ StatusCode = 200; Content = '<title>Other app</title>' }
    Assert-Companion (-not (Test-NinoCompanionHttpHealth)) 'another server on port 8000 is not ready Companion'
    Assert-CompanionThrows { Wait-NinoCompanionHttpHealth -TimeoutSeconds 0 } 'an opened app without a running server never reports ready'
    $script:httpResponse = New-Object Exception('connection refused')
    Assert-Companion (-not (Test-NinoCompanionHttpHealth)) 'failed HTTP request is not success'
    $script:httpResponse = [pscustomobject]@{ StatusCode = 200; Content = '<title>Bitfocus Companion - Admin</title>' }

    [void](New-Item -ItemType Directory -Path (Split-Path -Parent $layout.StudioLauncher) -Force)
    [IO.File]::WriteAllText($layout.StudioLauncher, 'fixture, never executed')
    $script:running = @()
    $script:starts = @()
    $script:studioExitCode = 0
    function Get-NinoCompanionProcesses { return $script:running }
    function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$Wait, [switch]$PassThru, $ErrorAction)
        $script:starts += [pscustomobject]@{ FilePath = $FilePath; Arguments = $ArgumentList; Wait = [bool]$Wait; WorkingDirectory = $WorkingDirectory }
        return [pscustomobject]@{ ExitCode = $script:studioExitCode }
    }
    Start-NinoCompanionApplication -ExecutablePath $executable -Layout $layout
    Assert-Companion ($script:starts.Count -eq 2) 'background studio starts once before Companion'
    Assert-Companion ($script:starts[0].FilePath -eq $layout.PowerShellPath -and $script:starts[0].Wait) 'bootstrap waits for the fixed health-checking launcher'
    Assert-Companion ($script:starts[0].Arguments.Contains('-NoBrowser -NoObs -NoDialogs')) 'background bootstrap opens neither OBS nor browser'
    Assert-Companion ($script:starts[0].Arguments.Contains('"' + $layout.StudioLauncher + '"')) 'background launch cannot change script target'
    Assert-Companion ($script:starts[1].FilePath -eq $executable -and -not $script:starts[1].Arguments) 'Companion receives no arbitrary CLI arguments'
    Assert-Companion (@($script:httpRequests | Where-Object { $_ -ne 'http://127.0.0.1:8000/' }).Count -eq 0) 'only a local read-only Companion health GET is used'
    $script:running = @([pscustomobject]@{ ExecutablePath = $executable })
    $script:starts = @()
    Start-NinoCompanionApplication -ExecutablePath $executable -Layout $layout
    Assert-Companion ($script:starts.Count -eq 1 -and $script:starts[0].Wait) 'existing Companion is reused while studio readiness is checked'
    $script:running = @([pscustomobject]@{ ExecutablePath = 'foreign.exe' })
    $script:starts = @()
    Assert-CompanionThrows { Start-NinoCompanionApplication -ExecutablePath $executable -Layout $layout } 'foreign Companion instance is not replaced'
    Assert-Companion ($script:starts.Count -eq 0) 'foreign process blocks all startup side effects'
    $script:running = @()
    $script:studioExitCode = 1
    Assert-CompanionThrows { Start-NinoCompanionApplication -ExecutablePath $executable -Layout $layout } 'failed studio readiness blocks Companion startup'
    Assert-Companion ($script:starts.Count -eq 1) 'Companion is not launched when studio startup fails'
    Write-Host ("Companion regression checks passed: {0}" -f $script:checks)
} finally {
    $env:WINDIR = $originalWindows
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
