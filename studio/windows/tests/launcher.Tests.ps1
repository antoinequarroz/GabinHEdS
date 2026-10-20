#requires -Version 5.1
# Dependency-free launcher regression checks, runnable by Windows PowerShell 5.1
# or PowerShell 7. No process is started, stopped, or contacted by this suite.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../Launch-Nino.ps1')
$script:checks = 0
function Assert-Launcher {
    param([bool]$Condition, [string]$Message)
    $script:checks += 1
    if (-not $Condition) { throw "FAILED: $Message" }
}
function Assert-LauncherThrows {
    param([scriptblock]$Action, [string]$Message)
    $thrown = $false
    try { & $Action } catch { $thrown = $true }
    Assert-Launcher $thrown $Message
}

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('nino-launcher-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $scratch)
try {
    # These strings exercise native Windows quoting even when run on another OS.
    Assert-Launcher ((ConvertTo-NinoNativeArgument 'plain') -eq 'plain') 'simple argument'
    Assert-Launcher ((ConvertTo-NinoNativeArgument '') -eq '""') 'empty argument'
    Assert-Launcher ((ConvertTo-NinoNativeArgument 'C:\Nino Salle\app') -eq '"C:\Nino Salle\app"') 'spaces in install path'
    Assert-Launcher ((ConvertTo-NinoNativeArgument 'C:\Nino Salle\') -eq '"C:\Nino Salle\\"') 'trailing backslash in quoted path'
    Assert-Launcher ((ConvertTo-NinoNativeArgument 'with"quote') -eq '"with\"quote"') 'embedded quote'
    Assert-Launcher ((ConvertTo-NinoNativeArgument 'with\"quote') -eq '"with\\\"quote"') 'backslash before embedded quote'

    $layout = Get-NinoLayout -LauncherDirectory (Join-Path $scratch 'install/windows') -LocalAppData (Join-Path $scratch 'profile')
    Assert-Launcher ($layout.AppRoot -eq (Join-Path $scratch 'install/app')) 'release app root'
    Assert-Launcher ($layout.DataRoot -eq (Join-Path $scratch 'profile/Nino/data')) 'persistent data outside install'
    Assert-Launcher (-not $layout.DataRoot.StartsWith($layout.InstallRoot)) 'upgrade cannot replace data tree'
    Assert-Launcher ($layout.FfprobePath -eq (Join-Path $scratch 'profile/Nino/runtime/ffmpeg/9.0.2/bin/ffprobe.exe')) 'Resolve probe resolved from persistent runtime'

    $tokenPath = Join-Path $scratch 'shutdown-token.txt'
    Assert-LauncherThrows { Get-NinoShutdownToken -Path $tokenPath } 'stop cannot create a replacement token'
    $token = Get-NinoShutdownToken -Path $tokenPath -Create
    Assert-Launcher ($token -cmatch '^[A-Za-z0-9_-]{43}$') 'cryptographic 256-bit lifecycle token'
    Assert-Launcher ((Get-NinoShutdownToken -Path $tokenPath -Create) -ceq $token) 'idempotent launch preserves the running API token'
    'invalid' | Set-Content -LiteralPath $tokenPath -Encoding ASCII
    Assert-LauncherThrows { Get-NinoShutdownToken -Path $tokenPath -Create } 'corrupt token fails closed instead of silently replacing it'

    $settingsPath = Join-Path $scratch 'settings.json'
    $settings = Get-NinoSettings $settingsPath
    Assert-Launcher (-not $settings.ListenOnLan -and $null -eq $settings.ObsPath) 'local-only default without settings'
    '{"listenOnLan":true}' | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    Assert-Launcher ((Get-NinoSettings $settingsPath).ListenOnLan) 'explicit LAN opt-in'
    '{"listenOnLan":"true"}' | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    Assert-LauncherThrows { Get-NinoSettings $settingsPath } 'reject truthy string masquerading as boolean'
    '{"listenOnLan":false,"unexpected":"value"}' | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    Assert-LauncherThrows { Get-NinoSettings $settingsPath } 'reject unknown settings'
    '{"obsPath":"calc.exe"}' | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    Assert-LauncherThrows { Get-NinoSettings $settingsPath } 'reject unrelated OBS executable'
    '[true]' | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    Assert-LauncherThrows { Get-NinoSettings $settingsPath } 'reject non-object settings'
    '{' | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    Assert-LauncherThrows { Get-NinoSettings $settingsPath } 'reject invalid JSON'

    $started = [datetime]::UtcNow
    $exe = 'C:\Program Files\Nino\runtime\node\node.exe'
    $anchor = 'C:\Program Files\Nino\app\apps\api\src\index.ts'
    $install = 'C:\Program Files\Nino'
    $record = [pscustomobject]@{ pid = 123; startedAtUtc = $started.ToString('o'); executablePath = $exe; anchor = $anchor; installRoot = $install }
    $info = [pscustomobject]@{ ProcessId = 123; ExecutablePath = $exe; CommandLine = '"' + $exe + '" --import tsx "' + $anchor + '"' }
    function Test-Identity {
        return Test-NinoProcessIdentity -Record $record -ProcessInfo $info -StartTimeUtc $started -InstallRoot $install -ExecutablePath $exe -Anchor $anchor
    }
    Assert-Launcher (Test-Identity) 'recorded PID, creation time, binary and command are owned'
    $info.ProcessId = 124
    Assert-Launcher (-not (Test-Identity)) 'unrelated PID is foreign'
    $info.ProcessId = 123
    $record.startedAtUtc = $started.AddMinutes(-2).ToString('o')
    Assert-Launcher (-not (Test-Identity)) 'recycled PID is foreign'
    $record.startedAtUtc = $started.ToString('o')
    $info.ExecutablePath = 'C:\Other\node.exe'
    Assert-Launcher (-not (Test-Identity)) 'same-name executable elsewhere is foreign'
    $info.ExecutablePath = $exe
    $info.CommandLine = 'node --import tsx C:\Other\index.ts'
    Assert-Launcher (-not (Test-Identity)) 'same binary running another app is foreign'
    $info.CommandLine = $anchor
    $record.installRoot = 'C:\Other'
    Assert-Launcher (-not (Test-Identity)) 'another installation is foreign'
    $record.installRoot = $install
    $record.startedAtUtc = 'bad timestamp'
    Assert-Launcher (-not (Test-Identity)) 'invalid ownership file fails closed'

    # Replace OS/network boundaries only in this test script's scope.
    function Get-NetTCPConnection {
        param($State, $ErrorAction)
        if ($script:portInventoryFails) { throw 'permission denied' }
        return $script:listeners
    }
    $script:portInventoryFails = $false
    $script:listeners = @([pscustomobject]@{ LocalAddress = '0.0.0.0'; LocalPort = 4310; OwningProcess = 999 })
    Assert-LauncherThrows { Assert-NinoPortsAvailable -Ports @(4310, 4312) -Service api } 'occupied port rejected'
    Assert-NinoPortsAvailable -Ports @(9997, 8888) -Service media
    Assert-Launcher $true 'unrelated listeners do not block selected ports'
    $script:portInventoryFails = $true
    Assert-LauncherThrows { Assert-NinoPortsAvailable -Ports @(4310) -Service api } 'failed port inventory is not a free port'

    function Invoke-WebRequest {
        param($Uri, [switch]$UseBasicParsing, $TimeoutSec, $ErrorAction, $Method, $Headers)
        if ($script:healthFails) { throw 'network unavailable' }
        if ($Uri -like '*local-shutdown') {
            [void]$script:shutdownTrace.Add('shutdown-request')
            if ($Method -ne 'Post' -or $Headers.Authorization -cne ('Bearer ' + $script:expectedToken)) { throw 'wrong shutdown credentials' }
            if ($script:shutdownBlocked) { throw 'HTTP 409: room is busy' }
            return [pscustomobject]@{ StatusCode = 202; Content = '{"accepted":true}' }
        }
        if ($Uri -like '*9997*') { return [pscustomobject]@{ StatusCode = 200; Content = $script:mediaBody } }
        if ($Uri -like '*4312*') { return [pscustomobject]@{ StatusCode = 200; Content = $script:guestBody } }
        return [pscustomobject]@{ StatusCode = 200; Content = $script:studioBody }
    }
    $script:healthFails = $false
    $script:studioBody = '{"mode":"studio"}'
    $script:guestBody = '{"mode":"guest","configured":false}'
    $script:mediaBody = '{"items":[],"itemCount":0,"pageCount":0}'
    Assert-Launcher (Test-NinoHttpHealth api) 'both actual API listeners ready'
    Assert-Launcher (Test-NinoHttpHealth media) 'MediaMTX real API ready'
    Assert-Launcher (Test-NinoMediaIdle) 'empty media relay can close safely'
    $script:mediaBody = '{"items":[{"ready":false,"source":null}],"itemCount":1}'
    Assert-Launcher (Test-NinoMediaIdle) 'configured path without publisher can close safely'
    $script:mediaBody = '{"items":[{"ready":true,"source":{"id":"publisher"}}],"itemCount":1}'
    Assert-Launcher (-not (Test-NinoMediaIdle)) 'active publisher blocks relay shutdown'
    $script:mediaBody = '{"items":[{"ready":false}],"itemCount":1}'
    Assert-Launcher (-not (Test-NinoMediaIdle)) 'unknown publisher state blocks shutdown'
    $script:mediaBody = '{"items":[],"itemCount":5}'
    Assert-Launcher (-not (Test-NinoMediaIdle)) 'incomplete paginated state blocks shutdown'
    $script:guestBody = '{"mode":"studio"}'
    Assert-Launcher (-not (Test-NinoHttpHealth api)) 'wrong guest service does not count as ready'
    $script:guestBody = 'not JSON'
    Assert-Launcher (-not (Test-NinoHttpHealth api)) 'arbitrary successful HTTP response not ready'
    $script:mediaBody = '{"status":"ok"}'
    Assert-Launcher (-not (Test-NinoHttpHealth media)) 'unrelated MediaMTX port response not ready'
    $script:healthFails = $true
    Assert-Launcher (-not (Test-NinoHttpHealth api)) 'network failure is not readiness'

    # Verify the lifecycle order with inert process objects: API authorization
    # and graceful exit must precede any owned MediaMTX termination.
    $script:healthFails = $false
    $script:portInventoryFails = $false
    $script:listeners = @()
    Remove-Item -LiteralPath $tokenPath
    $script:expectedToken = Get-NinoShutdownToken -Path $tokenPath -Create
    $stopLayout = [pscustomobject]@{ RunRoot = $scratch; InstallRoot = $install; NodePath = $exe; EntryPath = $anchor;
        MediaPath = 'C:\Nino\mediamtx.exe'; MediaConfigPath = 'C:\Nino\app\config\mediamtx.yml'; ShutdownTokenPath = $tokenPath }
    $script:shutdownTrace = New-Object 'Collections.Generic.List[string]'
    $script:shutdownBlocked = $false
    $script:apiCanExit = $true
    $script:apiOwned = $true
    $script:fakeApi = [pscustomobject]@{ Id = 123 }
    $script:fakeApi | Add-Member ScriptMethod WaitForExit {
        param($timeout)
        [void]$script:shutdownTrace.Add('api-exit')
        return $script:apiCanExit
    }
    $script:fakeMedia = [pscustomobject]@{ Id = 124 }
    $script:fakeMedia | Add-Member ScriptMethod Kill { [void]$script:shutdownTrace.Add('media-close') }
    $script:fakeMedia | Add-Member ScriptMethod WaitForExit { param($timeout); [void]$script:shutdownTrace.Add('media-exit'); return $true }
    function Get-NinoOwnedProcess {
        param($StatePath, $InstallRoot, $ExecutablePath, $Anchor)
        if ($StatePath -like '*api.json') { if ($script:apiOwned) { return $script:fakeApi }; return $null }
        return $script:fakeMedia
    }
    $script:mediaBody = '{"items":[],"itemCount":0}'
    Stop-NinoServices -Layout $stopLayout
    Assert-Launcher (($script:shutdownTrace -join ',') -eq 'shutdown-request,api-exit,media-close,media-exit') 'graceful API exit precedes closing owned relay'
    $script:shutdownTrace.Clear()
    $script:shutdownBlocked = $true
    Assert-LauncherThrows { Stop-NinoServices -Layout $stopLayout } 'active or uncertain room rejects shutdown'
    Assert-Launcher (($script:shutdownTrace -join ',') -eq 'shutdown-request') 'refused shutdown never waits on or kills processes'
    $script:shutdownTrace.Clear()
    $script:shutdownBlocked = $false
    $script:apiCanExit = $false
    Assert-LauncherThrows { Stop-NinoServices -Layout $stopLayout } 'API exit timeout blocks relay closure'
    Assert-Launcher (-not $script:shutdownTrace.Contains('media-close')) 'API timeout never forces a process to quit'
    $script:shutdownTrace.Clear()
    $script:apiCanExit = $true
    $script:apiOwned = $false
    $script:listeners = @([pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 4310; OwningProcess = 999 })
    Assert-LauncherThrows { Stop-NinoServices -Layout $stopLayout } 'unowned API port blocks shutdown'
    Assert-Launcher ($script:shutdownTrace.Count -eq 0) 'no shutdown request or kill for unowned service'
    $script:listeners = @()
    $script:mediaBody = '{"items":[{"ready":true,"source":{"id":"publisher"}}],"itemCount":1}'
    Assert-LauncherThrows { Stop-NinoServices -Layout $stopLayout } 'orphan relay with active publisher cannot close'
    Assert-Launcher ($script:shutdownTrace.Count -eq 0) 'active orphan relay remains running'

    Write-Host "Launcher regression checks passed: $script:checks"
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
