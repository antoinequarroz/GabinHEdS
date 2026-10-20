#requires -Version 5.1
[CmdletBinding()]
param(
    # Root of private user files, NOT the SQLite data subdirectory.
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'Nino'),
    [switch]$InstallOBS,
    [switch]$OnlyOBS
)

$ErrorActionPreference = 'Stop'

function Get-NinoDownload {
    param($Package, [string]$Directory, [string]$Suffix)
    $uri = $null
    if (-not [Uri]::TryCreate([string]$Package.url, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or $uri.Host -notin @('github.com', 'nodejs.org') -or
        $uri.UserInfo -or $uri.Fragment -or $Package.sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Le manifeste de telechargement Nino est invalide.'
    }
    [void](New-Item -ItemType Directory -Path $Directory -Force)
    $target = Join-Path $Directory ($Package.sha256 + $Suffix)
    if ((Test-Path -LiteralPath $target -PathType Leaf) -and
        (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Package.sha256) {
        return $target
    }
    $partial = $target + '.' + [guid]::NewGuid().ToString('N') + '.partial'
    try {
        Write-Host ('Telechargement verifie : {0}' -f $Package.url)
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $previousProgress = $ProgressPreference
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $Package.url -OutFile $partial -UseBasicParsing -TimeoutSec 300
        } finally { $ProgressPreference = $previousProgress }
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Package.sha256) {
            throw 'Empreinte du telechargement incorrecte : aucun executable ne sera utilise.'
        }
        Move-Item -LiteralPath $partial -Destination $target -Force
        return $target
    } finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    }
}

function Expand-NinoVerifiedZip {
    param([string]$Archive, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        [long]$total = 0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or @($name.Split('/') | Where-Object { $_ -eq '..' }).Count -gt 0) {
                throw 'Archive non sure : chemin externe refuse.'
            }
            $total += $entry.Length
        }
        if ($total -gt 2GB) { throw 'Archive trop volumineuse.' }
    } finally { $zip.Dispose() }
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
}

function Initialize-NinoFfmpeg {
    param($Package, [string]$Root)
    if ($Package.version -cnotmatch '^\d+\.\d+\.\d+$' -or $Package.archiveRoot -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw 'La version ou le dossier du paquet FFmpeg est invalide.'
    }
    $destination = Join-Path $Root ('runtime/ffmpeg/' + $Package.version)
    $ffmpeg = Join-Path $destination 'bin/ffmpeg.exe'
    $ffprobe = Join-Path $destination 'bin/ffprobe.exe'
    $receipt = Join-Path $destination 'nino-runtime.json'
    if ((Test-Path -LiteralPath $ffmpeg -PathType Leaf) -and (Test-Path -LiteralPath $ffprobe -PathType Leaf) -and
        (Test-Path -LiteralPath $receipt -PathType Leaf)) {
        $saved = $null
        try { $saved = Get-Content -LiteralPath $receipt -Raw -Encoding UTF8 | ConvertFrom-Json }
        catch { Write-Host 'Le recu FFmpeg est incomplet ; preparation a nouveau.' }
        if ($null -ne $saved -and $saved.archiveSha256 -eq $Package.sha256 -and
            $saved.ffmpegSha256 -eq (Get-FileHash -LiteralPath $ffmpeg -Algorithm SHA256).Hash.ToLowerInvariant() -and
            $saved.ffprobeSha256 -eq (Get-FileHash -LiteralPath $ffprobe -Algorithm SHA256).Hash.ToLowerInvariant()) {
            Write-Host ('FFmpeg {0} est deja pret.' -f $Package.version)
            return
        }
    }
    $archive = Get-NinoDownload -Package $Package -Directory (Join-Path $Root 'downloads') -Suffix '.zip'
    $stage = Join-Path $Root ('runtime/ffmpeg/.prepare-' + [guid]::NewGuid().ToString('N'))
    try {
        [void](New-Item -ItemType Directory -Path $stage -Force)
        Expand-NinoVerifiedZip -Archive $archive -Destination $stage
        $extracted = Join-Path $stage $Package.archiveRoot
        $newFfmpeg = Join-Path $extracted 'bin/ffmpeg.exe'
        $newProbe = Join-Path $extracted 'bin/ffprobe.exe'
        if (-not (Test-Path -LiteralPath $newFfmpeg -PathType Leaf) -or -not (Test-Path -LiteralPath $newProbe -PathType Leaf)) {
            throw 'Le paquet FFmpeg ne contient pas les deux outils attendus.'
        }
        # Native stderr is an ErrorRecord in Windows PowerShell 5.1. Capture it
        # separately so harmless FFmpeg diagnostics cannot masquerade as failure.
        $stdout = Join-Path $stage 'encoders.stdout.txt'
        $stderr = Join-Path $stage 'encoders.stderr.txt'
        $process = Start-Process -FilePath $newFfmpeg -ArgumentList '-hide_banner -encoders' -Wait -PassThru `
            -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $encoders = (Get-Content -LiteralPath $stdout -Raw) + (Get-Content -LiteralPath $stderr -Raw)
        if ($process.ExitCode -ne 0 -or $encoders -notmatch 'libx264' -or $encoders -notmatch '\baac\b') {
            throw 'FFmpeg ne fournit pas les encodeurs H.264 et AAC requis.'
        }
        [ordered]@{
            version = $Package.version; archiveSha256 = $Package.sha256; source = $Package.source
            ffmpegSha256 = (Get-FileHash -LiteralPath $newFfmpeg -Algorithm SHA256).Hash.ToLowerInvariant()
            ffprobeSha256 = (Get-FileHash -LiteralPath $newProbe -Algorithm SHA256).Hash.ToLowerInvariant()
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $extracted 'nino-runtime.json') -Encoding UTF8
        if (Test-Path -LiteralPath $destination) {
            $active = @(Get-CimInstance Win32_Process -Filter "Name = 'ffmpeg.exe' OR Name = 'ffprobe.exe'" | Where-Object {
                $_.ExecutablePath -and $_.ExecutablePath.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)
            })
            if ($active.Count -gt 0) { throw 'FFmpeg est encore utilise. Terminez la production puis arretez Nino avant de reparer ses outils.' }
            Move-Item -LiteralPath $destination -Destination ($destination + '.previous-' + [guid]::NewGuid().ToString('N'))
        }
        Move-Item -LiteralPath $extracted -Destination $destination
        Write-Host ('FFmpeg {0} et ffprobe sont prets.' -f $Package.version)
    } finally {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
}

function Install-NinoObs {
    param($Package, [string]$Root)
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'obs-studio/bin/64bit/obs64.exe' }
    if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'obs-studio/bin/64bit/obs64.exe' }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            Write-Host 'OBS est deja installe. Sa configuration est conservee.'
            return
        }
    }
    $installer = Get-NinoDownload -Package $Package -Directory (Join-Path $Root 'downloads') -Suffix '.exe'
    Write-Host 'L installateur officiel OBS va s ouvrir. Validez ses etapes directement sur le PC.'
    $process = Start-Process -FilePath $installer -Wait -PassThru
    if ($process.ExitCode -notin @(0, 3010)) { throw ('OBS n a pas termine son installation (code {0}).' -f $process.ExitCode) }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($env:OS -ne 'Windows_NT') { throw 'Cette preparation est reservee a Windows.' }
        if ($OnlyOBS -and -not $InstallOBS) { throw 'OnlyOBS exige InstallOBS.' }
        $lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        [void](New-Item -ItemType Directory -Path $DataRoot -Force)
        if (-not $OnlyOBS) { Initialize-NinoFfmpeg -Package $lock.ffmpeg -Root $DataRoot }
        if ($InstallOBS) { Install-NinoObs -Package $lock.obs -Root $DataRoot }
        exit 0
    } catch {
        Write-Error ('Nino : preparation incomplete. ' + $_.Exception.Message) -ErrorAction Continue
        exit 1
    }
}
