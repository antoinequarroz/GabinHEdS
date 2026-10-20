#requires -Version 5.1
<#
  Nino room launcher. It never starts a recording or a live stream. -Stop asks
  the API to prove the room is idle before closing owned services; OBS stays
  open. Dot-source this file to exercise its pure helpers.
#>
[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$NoObs,
    [switch]$NoDialogs,
    [switch]$Stop,
    [ValidateRange(5, 300)][int]$StartupTimeoutSeconds = 90
)

function ConvertTo-NinoNativeArgument {
    param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Value)
    # Start-Process joins ArgumentList with spaces, without preserving quoting.
    # Apply the Windows CommandLineToArgvW escaping rules to every argument.
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Get-NinoLayout {
    param([Parameter(Mandatory = $true)][string]$LauncherDirectory,
          [Parameter(Mandatory = $true)][string]$LocalAppData)
    $installation = [IO.Path]::GetFullPath((Join-Path $LauncherDirectory '..'))
    $app = Join-Path $installation 'app'
    $userRoot = Join-Path $LocalAppData 'Nino'
    return [pscustomobject]@{
        InstallRoot = $installation
        AppRoot = $app
        UserRoot = $userRoot
        DataRoot = Join-Path $userRoot 'data'
        LogRoot = Join-Path $userRoot 'logs'
        RunRoot = Join-Path $userRoot 'run'
        SettingsPath = Join-Path $userRoot 'settings.json'
        NodePath = Join-Path $installation 'runtime/node/node.exe'
        FfmpegPath = Join-Path $userRoot 'runtime/ffmpeg/9.0.2/bin/ffmpeg.exe'
        FfprobePath = Join-Path $userRoot 'runtime/ffmpeg/9.0.2/bin/ffprobe.exe'
        MediaPath = Join-Path $installation 'runtime/mediamtx/mediamtx.exe'
        MediaConfigPath = Join-Path $app 'config/mediamtx.yml'
        LoaderPath = Join-Path $app 'node_modules/tsx/dist/loader.mjs'
        EntryPath = Join-Path $app 'apps/api/src/index.ts'
        WebPath = Join-Path $app 'apps/web/dist/index.html'
        PrepareRuntimePath = Join-Path $installation 'windows/Prepare-Runtime.ps1'
        ShutdownTokenPath = Join-Path $userRoot 'run/shutdown-token.txt'
    }
}

function Get-NinoShutdownToken {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Create)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $token = (Get-Content -LiteralPath $Path -Raw -Encoding ASCII).Trim()
        if ($token -cnotmatch '^[A-Za-z0-9_-]{43}$') { throw 'Le jeton local du lanceur est invalide. Consultez le support avant de relancer.' }
        return $token
    }
    if (-not $Create) { throw 'Le jeton local du lanceur est absent. Aucun service ne sera arrete.' }
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $token | Set-Content -LiteralPath $Path -Encoding ASCII -NoNewline
    return $token
}

function Wait-NinoSetup {
    # Inno Setup keeps its mutex during the optional Finish-page launch. Wait
    # for it to exit before starting services or opening files it is replacing.
    $deadline = [datetime]::UtcNow.AddSeconds(60)
    $notified = $false
    do {
        $setup = $null
        try { $setup = [Threading.Mutex]::OpenExisting('NinoStudio.Windows.Setup') }
        catch [Threading.WaitHandleCannotBeOpenedException] { return }
        finally { if ($null -ne $setup) { $setup.Dispose() } }
        # SetupMutex represents object existence, not necessarily mutex
        # ownership. Release our handle before polling, so we cannot keep the
        # setup mutex alive after the installer exits.
        if (-not $notified) {
            Write-Host 'Nino : installation en cours, attente de la fermeture de l installateur...'
            $notified = $true
        }
        Start-Sleep -Milliseconds 250
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'Terminez ou fermez l installateur Nino, puis relancez le raccourci.'
}

function Get-NinoSettings {
    param([Parameter(Mandatory = $true)][string]$Path)
    $settings = [pscustomobject]@{ ListenOnLan = $false; ObsPath = $null }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $settings }
    try {
        $source = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        # ConvertFrom-Json unwraps single-element arrays in Windows PowerShell.
        if (-not $source.TrimStart().StartsWith('{')) { throw 'JSON object required' }
        $saved = $source | ConvertFrom-Json
    }
    catch { throw "Le fichier de configuration est invalide : $Path" }
    if ($null -eq $saved -or $saved -is [array] -or $saved -isnot [pscustomobject]) {
        throw "La configuration doit contenir un objet JSON : $Path"
    }
    foreach ($key in $saved.PSObject.Properties.Name) {
        if ($key -notin @('listenOnLan', 'obsPath')) { throw "Reglage Nino inconnu : $key" }
    }
    if ($null -ne $saved.PSObject.Properties['listenOnLan']) {
        if ($saved.listenOnLan -isnot [bool]) { throw 'listenOnLan doit etre un booleen JSON (true ou false).' }
        $settings.ListenOnLan = $saved.listenOnLan
    }
    if ($null -ne $saved.PSObject.Properties['obsPath'] -and $null -ne $saved.obsPath) {
        if ($saved.obsPath -isnot [string] -or -not [IO.Path]::IsPathRooted($saved.obsPath) -or
            [IO.Path]::GetFileName($saved.obsPath) -notin @('obs64.exe', 'obs32.exe')) {
            throw 'obsPath doit etre le chemin complet vers obs64.exe.'
        }
        $settings.ObsPath = $saved.obsPath
    }
    return $settings
}

function Test-NinoProcessIdentity {
    param([Parameter(Mandatory = $true)]$Record,
          [Parameter(Mandatory = $true)]$ProcessInfo,
          [Parameter(Mandatory = $true)][datetime]$StartTimeUtc,
          [Parameter(Mandatory = $true)][string]$InstallRoot,
          [Parameter(Mandatory = $true)][string]$ExecutablePath,
          [Parameter(Mandatory = $true)][string]$Anchor)
    try {
        foreach ($key in @('pid', 'startedAtUtc', 'executablePath', 'anchor', 'installRoot')) {
            if ($null -eq $Record.PSObject.Properties[$key]) { return $false }
        }
        if ([int]$Record.pid -ne [int]$ProcessInfo.ProcessId -or [int]$Record.pid -le 0) { return $false }
        foreach ($pair in @(@($Record.installRoot, $InstallRoot), @($Record.executablePath, $ExecutablePath),
                            @($ProcessInfo.ExecutablePath, $ExecutablePath), @($Record.anchor, $Anchor))) {
            if (-not [string]::Equals([string]$pair[0], [string]$pair[1], [StringComparison]::OrdinalIgnoreCase)) { return $false }
        }
        $recordedStart = [datetime]::Parse([string]$Record.startedAtUtc, [Globalization.CultureInfo]::InvariantCulture,
                                         [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        if ([Math]::Abs(($StartTimeUtc.ToUniversalTime() - $recordedStart).TotalSeconds) -gt 1) { return $false }
        if ([string]::IsNullOrWhiteSpace([string]$ProcessInfo.CommandLine)) { return $false }
        return ([string]$ProcessInfo.CommandLine).IndexOf($Anchor, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } catch { return $false }
}

function Get-NinoOwnedProcess {
    param([Parameter(Mandatory = $true)][string]$StatePath,
          [Parameter(Mandatory = $true)][string]$InstallRoot,
          [Parameter(Mandatory = $true)][string]$ExecutablePath,
          [Parameter(Mandatory = $true)][string]$Anchor)
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
    try {
        $record = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $record -or $null -eq $record.PSObject.Properties['pid'] -or [int]$record.pid -le 0) { return $null }
        $process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
        if ($null -eq $process) { return $null }
        $info = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f [int]$record.pid) -ErrorAction Stop
        if ($null -ne $info -and (Test-NinoProcessIdentity -Record $record -ProcessInfo $info -StartTimeUtc $process.StartTime.ToUniversalTime() `
                -InstallRoot $InstallRoot -ExecutablePath $ExecutablePath -Anchor $Anchor)) { return $process }
    } catch { return $null }
    return $null
}

function Get-NinoPortOwners {
    param([Parameter(Mandatory = $true)][int[]]$Ports)
    # Windows 11 includes this module. A failed inventory must not be interpreted
    # as a free port; callers stop and show the diagnostic instead.
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
    return @($listeners | Where-Object { $_.LocalPort -in $Ports } |
        Select-Object LocalAddress, LocalPort, OwningProcess -Unique)
}

function Assert-NinoPortsAvailable {
    param([Parameter(Mandatory = $true)][int[]]$Ports,
          [Parameter(Mandatory = $true)][string]$Service)
    $occupied = @(Get-NinoPortOwners -Ports $Ports)
    if ($occupied.Count -gt 0) {
        $details = ($occupied | ForEach-Object { '{0} (PID {1})' -f $_.LocalPort, $_.OwningProcess }) -join ', '
        throw "$Service ne peut pas demarrer : port deja utilise ($details). Aucun programme n'a ete arrete. Fermez l'autre instance si elle n'enregistre pas, puis relancez Nino."
    }
}

function Test-NinoHttpHealth {
    param([Parameter(Mandatory = $true)][ValidateSet('api', 'media')][string]$Service)
    try {
        if ($Service -eq 'media') {
            $result = Invoke-WebRequest -Uri 'http://127.0.0.1:9997/v3/paths/list' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            $body = $result.Content | ConvertFrom-Json
            return $result.StatusCode -eq 200 -and $null -ne $body.PSObject.Properties['items'] -and
                $null -ne $body.PSObject.Properties['itemCount']
        }
        $studio = Invoke-WebRequest -Uri 'http://127.0.0.1:4310/api/guest/config' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        $guest = Invoke-WebRequest -Uri 'http://127.0.0.1:4312/api/guest/config' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return $studio.StatusCode -eq 200 -and ($studio.Content | ConvertFrom-Json).mode -eq 'studio' -and
            $guest.StatusCode -eq 200 -and ($guest.Content | ConvertFrom-Json).mode -eq 'guest'
    } catch { return $false }
}

function Wait-NinoService {
    param([Parameter(Mandatory = $true)][ValidateSet('api', 'media')][string]$Service,
          [Parameter(Mandatory = $true)]$Process,
          [Parameter(Mandatory = $true)][int]$TimeoutSeconds)
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $Process.Refresh()
        if ($Process.HasExited) { throw "$Service s'est arrete pendant le demarrage (code $($Process.ExitCode)). Consultez les journaux Nino." }
        if (Test-NinoHttpHealth -Service $Service) { return }
        Start-Sleep -Milliseconds 400
    } while ([datetime]::UtcNow -lt $deadline)
    throw "$Service ne repond pas apres $TimeoutSeconds secondes. Aucun processus n'a ete arrete. Consultez les journaux Nino avant de relancer."
}

function Start-NinoService {
    param([Parameter(Mandatory = $true)][ValidateSet('api', 'media')][string]$Service,
          [Parameter(Mandatory = $true)]$Layout,
          [Parameter(Mandatory = $true)][string]$ExecutablePath,
          [Parameter(Mandatory = $true)][string[]]$Arguments,
          [Parameter(Mandatory = $true)][string]$Anchor,
          [Parameter(Mandatory = $true)][int[]]$Ports,
          [Parameter(Mandatory = $true)][int]$TimeoutSeconds)
    $statePath = Join-Path $Layout.RunRoot ($Service + '.json')
    $process = Get-NinoOwnedProcess -StatePath $statePath -InstallRoot $Layout.InstallRoot -ExecutablePath $ExecutablePath -Anchor $Anchor
    if ($null -ne $process) {
        # Also ensure a foreign listener has not claimed one of this service's
        # other ports. An HTTP answer alone is not proof of process ownership.
        $foreign = @(Get-NinoPortOwners -Ports $Ports | Where-Object { [int]$_.OwningProcess -ne $process.Id })
        if ($foreign.Count -gt 0) { throw "Un autre programme utilise un port de $Service. Aucun processus n'a ete arrete." }
        Write-Host "Nino : reutilisation de $Service (PID $($process.Id))."
        Wait-NinoService -Service $Service -Process $process -TimeoutSeconds $TimeoutSeconds
        return $process
    }
    Assert-NinoPortsAvailable -Ports $Ports -Service $Service
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $Layout.LogRoot "$Service-$stamp.log"
    $stderr = Join-Path $Layout.LogRoot "$Service-$stamp.error.log"
    $argumentLine = ($Arguments | ForEach-Object { ConvertTo-NinoNativeArgument -Value $_ }) -join ' '
    $process = Start-Process -FilePath $ExecutablePath -ArgumentList $argumentLine -WorkingDirectory $Layout.AppRoot `
        -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -ErrorAction Stop
    $record = [ordered]@{ pid = $process.Id; startedAtUtc = $process.StartTime.ToUniversalTime().ToString('o');
        executablePath = $ExecutablePath; anchor = $Anchor; installRoot = $Layout.InstallRoot }
    $temporary = $statePath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $record | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
    Write-Host "Nino : demarrage de $Service..."
    Wait-NinoService -Service $Service -Process $process -TimeoutSeconds $TimeoutSeconds
    # Check ports again after startup, in case another program won a bind race.
    $foreign = @(Get-NinoPortOwners -Ports $Ports | Where-Object { [int]$_.OwningProcess -ne $process.Id })
    if ($foreign.Count -gt 0) { throw "Un autre programme utilise un port de $Service. Consultez les journaux avant de relancer." }
    return $process
}

function Test-NinoMediaIdle {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:9997/v3/paths/list' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        $body = $response.Content | ConvertFrom-Json
        if ($response.StatusCode -ne 200 -or $null -eq $body.PSObject.Properties['items'] -or
            $null -eq $body.PSObject.Properties['itemCount']) { return $false }
        $items = @($body.items)
        if ([int]$body.itemCount -ne $items.Count) { return $false }
        foreach ($item in $items) {
            if ($null -eq $item.PSObject.Properties['ready'] -or $item.ready -isnot [bool] -or $item.ready -or
                $null -eq $item.PSObject.Properties['source'] -or $null -ne $item.source) { return $false }
        }
        return $true
    } catch { return $false }
}

function Stop-NinoServices {
    param([Parameter(Mandatory = $true)]$Layout)
    $apiState = Join-Path $Layout.RunRoot 'api.json'
    $mediaState = Join-Path $Layout.RunRoot 'media.json'
    $api = Get-NinoOwnedProcess -StatePath $apiState -InstallRoot $Layout.InstallRoot -ExecutablePath $Layout.NodePath -Anchor $Layout.EntryPath
    if ($null -ne $api) {
        $foreign = @(Get-NinoPortOwners -Ports @(4310, 4312) | Where-Object { [int]$_.OwningProcess -ne $api.Id })
        if ($foreign.Count -gt 0) { throw 'Un autre programme utilise un port Nino. Aucun service ne sera arrete.' }
        $token = Get-NinoShutdownToken -Path $Layout.ShutdownTokenPath
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4310/api/local-shutdown' -Method Post -UseBasicParsing `
                -Headers @{ Authorization = 'Bearer ' + $token } -TimeoutSec 10 -ErrorAction Stop
            $body = $response.Content | ConvertFrom-Json
            if ($response.StatusCode -ne 202 -or $body.accepted -ne $true) { throw 'Arret non confirme.' }
        } catch {
            throw 'Nino ne peut pas confirmer un arret sans danger. Terminez les enregistrements et le live, connectez OBS dans Nino puis reessayez. Aucun processus n a ete force a quitter.'
        }
        if (-not $api.WaitForExit(20000)) {
            throw 'Nino a accepte l arret mais son serveur ne s est pas ferme. OBS et le relais video restent ouverts ; consultez les journaux.'
        }
        Remove-Item -LiteralPath $apiState -Force -ErrorAction SilentlyContinue
    } else {
        # Missing/stale metadata never authorizes stopping a listener by name.
        Assert-NinoPortsAvailable -Ports @(4310, 4312) -Service Nino
    }
    $media = Get-NinoOwnedProcess -StatePath $mediaState -InstallRoot $Layout.InstallRoot -ExecutablePath $Layout.MediaPath -Anchor $Layout.MediaConfigPath
    if ($null -ne $media) {
        $foreign = @(Get-NinoPortOwners -Ports @(9997, 8554, 1935, 8888) | Where-Object { [int]$_.OwningProcess -ne $media.Id })
        if ($foreign.Count -gt 0 -or -not (Test-NinoMediaIdle)) {
            throw 'Le relais video est actif ou son etat est incertain. Il reste ouvert. Arretez la diffusion dans OBS avant de reessayer.'
        }
        # This is the freshly verified Process object, not a name-based kill.
        # OBS is never closed. The API has exited gracefully before this point.
        $media.Kill()
        if (-not $media.WaitForExit(10000)) { throw 'Le relais video ne s est pas ferme. Consultez les journaux Nino.' }
        Remove-Item -LiteralPath $mediaState -Force -ErrorAction SilentlyContinue
    }
    Write-Host 'Les services Nino sont arretes. OBS reste ouvert. Vous pouvez maintenant mettre Nino a jour.'
}

function Find-NinoObs {
    param([AllowNull()][string]$ConfiguredPath)
    if ($ConfiguredPath) {
        if (-not (Test-Path -LiteralPath $ConfiguredPath -PathType Leaf)) { throw "OBS est introuvable au chemin configure : $ConfiguredPath" }
        return $ConfiguredPath
    }
    $candidates = @()
    foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\obs64.exe',
                            'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\obs64.exe')) {
        $key = Get-Item -LiteralPath $registry -ErrorAction SilentlyContinue
        if ($null -ne $key) { $candidates += $key.GetValue('') }
    }
    if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'obs-studio/bin/64bit/obs64.exe' }
    if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'obs-studio/bin/64bit/obs64.exe' }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return [string]$candidate }
    }
    return $null
}

function Show-NinoMessage {
    param([Parameter(Mandatory = $true)][string]$Message, [switch]$IsError)
    if ($IsError) { Write-Warning $Message } else { Write-Host $Message }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $icon = if ($IsError) { [Windows.Forms.MessageBoxIcon]::Error } else { [Windows.Forms.MessageBoxIcon]::Information }
        [void][Windows.Forms.MessageBox]::Show($Message, 'Nino Studio', [Windows.Forms.MessageBoxButtons]::OK, $icon)
    } catch { Write-Warning 'La notification Windows est indisponible. Consultez ce terminal.' }
}

function Invoke-NinoLauncher {
    param([Parameter(Mandatory = $true)][string]$LauncherDirectory,
          [switch]$NoBrowser, [switch]$NoObs, [switch]$NoDialogs, [switch]$Stop, [int]$StartupTimeoutSeconds = 90)
    $ErrorActionPreference = 'Stop'
    $mutex = $null
    $installerGuard = $null
    $locked = $false
    $layout = $null
    try {
        if ($env:OS -ne 'Windows_NT' -or -not $env:LOCALAPPDATA) { throw 'Ce lanceur est destine au PC Windows 11 de la salle.' }
        $layout = Get-NinoLayout -LauncherDirectory $LauncherDirectory -LocalAppData $env:LOCALAPPDATA
        if (-not $Stop) { Wait-NinoSetup }
        foreach ($directory in @($layout.DataRoot, $layout.LogRoot, $layout.RunRoot)) {
            [void](New-Item -ItemType Directory -Path $directory -Force)
        }
        $hash = [Security.Cryptography.SHA256]::Create()
        try { $digest = $hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($layout.UserRoot.ToLowerInvariant())) }
        finally { $hash.Dispose() }
        $mutexName = 'Local\Nino.Launcher.' + ([BitConverter]::ToString($digest).Replace('-', '').Substring(0, 20))
        $mutex = New-Object Threading.Mutex($false, $mutexName)
        try { $locked = $mutex.WaitOne(120000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Un demarrage Nino est deja en cours. Patientez puis relancez le raccourci.' }
        # Inno Setup's AppMutex checks this fixed name while dependencies are
        # still preparing (before the long-lived executables can be inventoried).
        $installerGuard = New-Object Threading.Mutex($false, 'NinoStudio.Windows.Launcher')

        if ($Stop) {
            Stop-NinoServices -Layout $layout
            return 0
        }
        foreach ($file in @($layout.NodePath, $layout.MediaPath, $layout.MediaConfigPath, $layout.LoaderPath, $layout.EntryPath, $layout.WebPath)) {
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Installation Nino incomplete : $file. Relancez l'installateur ; vos donnees ne seront pas supprimees." }
        }
        if (-not (Test-Path -LiteralPath $layout.FfmpegPath -PathType Leaf) -or -not (Test-Path -LiteralPath $layout.FfprobePath -PathType Leaf)) {
            if (-not (Test-Path -LiteralPath $layout.PrepareRuntimePath -PathType Leaf)) { throw 'Le preparateur des outils video manque. Relancez l installateur Nino.' }
            Write-Host 'Nino : preparation des outils video. Une connexion Internet est necessaire au premier lancement.'
            $global:LASTEXITCODE = 0
            & $layout.PrepareRuntimePath -DataRoot $layout.UserRoot
            if ($LASTEXITCODE -ne 0) { throw 'Les outils video n ont pas pu etre installes. Verifiez la connexion Internet puis relancez Nino.' }
            if (-not (Test-Path -LiteralPath $layout.FfmpegPath -PathType Leaf) -or -not (Test-Path -LiteralPath $layout.FfprobePath -PathType Leaf)) {
                throw 'Les outils video sont incomplets. Consultez les journaux Nino.'
            }
        }

        $settings = Get-NinoSettings -Path $layout.SettingsPath
        $env:GABIN_DATA_DIR = $layout.DataRoot
        $env:GABIN_HOST = if ($settings.ListenOnLan) { '0.0.0.0' } else { '127.0.0.1' }
        $env:GABIN_PORT = '4310'
        $env:NINO_GUEST_HOST = '127.0.0.1'
        $env:NINO_GUEST_PORT = '4312'
        $env:GABIN_FFMPEG_PATH = $layout.FfmpegPath
        $env:GABIN_FFPROBE_PATH = $layout.FfprobePath
        $env:NINO_LOCAL_SHUTDOWN_TOKEN = Get-NinoShutdownToken -Path $layout.ShutdownTokenPath -Create
        $env:GABIN_MEDIA_API_URL = 'http://127.0.0.1:9997'
        $env:GABIN_MEDIA_HLS_URL = 'http://127.0.0.1:8888'
        $env:GABIN_MEDIA_RTSP_URL = 'rtsp://127.0.0.1:8554'
        $env:GABIN_MEDIA_RTMP_URL = 'rtmp://127.0.0.1:1935'
        $env:GABIN_MEDIA_PATH = 'gabin/program'
        $env:PATH = (Split-Path -Parent $layout.NodePath) + ';' + (Split-Path -Parent $layout.FfmpegPath) + ';' + $env:PATH

        [void](Start-NinoService -Service media -Layout $layout -ExecutablePath $layout.MediaPath -Arguments @($layout.MediaConfigPath) `
            -Anchor $layout.MediaConfigPath -Ports @(9997, 8554, 1935, 8888) -TimeoutSeconds $StartupTimeoutSeconds)
        # A Windows drive path is not a valid ESM URL; tsx resolves via its package
        # name from AppRoot. The locked release contains this exact dependency.
        [void](Start-NinoService -Service api -Layout $layout -ExecutablePath $layout.NodePath `
            -Arguments @('--import', 'tsx', $layout.EntryPath) -Anchor $layout.EntryPath -Ports @(4310, 4312) -TimeoutSeconds $StartupTimeoutSeconds)

        $obsWarning = $null
        if (-not $NoObs) {
            $obs = @(Get-Process -Name obs64, obs32 -ErrorAction SilentlyContinue)
            if ($obs.Count -eq 0) {
                $obsPath = Find-NinoObs -ConfiguredPath $settings.ObsPath
                if ($obsPath) {
                    [void](Start-Process -FilePath $obsPath -WorkingDirectory (Split-Path -Parent $obsPath) -ErrorAction Stop)
                } else { $obsWarning = 'Nino est ouvert. Installez OBS Studio depuis https://obsproject.com/download, puis relancez ce raccourci. Dans Nino, connectez ensuite OBS : ouvrir OBS ne demarre aucun enregistrement ni live.' }
            }
        }
        if (-not $NoBrowser) { [void](Start-Process 'http://127.0.0.1:4310/') }
        Write-Host 'Nino est disponible : http://127.0.0.1:4310/ . Aucun enregistrement ni live n a ete lance.'
        if ($obsWarning) {
            if ($NoDialogs) { Write-Warning $obsWarning } else { Show-NinoMessage -Message $obsWarning }
        }
        return 0
    } catch {
        $message = $_.Exception.Message
        if ($null -ne $layout) {
            $message += "`r`n`r`nJournaux : $($layout.LogRoot)"
            if (Test-Path -LiteralPath $layout.LogRoot -PathType Container) {
                try { ('{0:o} {1}' -f [datetime]::UtcNow, $_.Exception.Message) | Add-Content -LiteralPath (Join-Path $layout.LogRoot 'launcher.log') -Encoding UTF8 }
                catch { Write-Warning 'Impossible d ecrire le journal du lanceur.' }
            }
        }
        if ($NoDialogs) { Write-Warning $message } else { Show-NinoMessage -Message $message -IsError }
        return 1
    } finally {
        if ($locked -and $null -ne $mutex) { $mutex.ReleaseMutex() }
        if ($null -ne $mutex) { $mutex.Dispose() }
        if ($null -ne $installerGuard) { $installerGuard.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-NinoLauncher -LauncherDirectory $PSScriptRoot -NoBrowser:$NoBrowser -NoObs:$NoObs -NoDialogs:$NoDialogs -Stop:$Stop -StartupTimeoutSeconds $StartupTimeoutSeconds
    exit $result
}
