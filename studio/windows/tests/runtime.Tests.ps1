#requires -Version 5.1
# Dependency-free runtime checks. Downloads are replaced with inert local
# fixtures, and no native executable or installer is run by these tests.
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { $env:LOCALAPPDATA = [IO.Path]::GetTempPath() }
. (Join-Path $PSScriptRoot '../Prepare-Runtime.ps1')
$script:checks = 0
function Assert-Runtime {
    param([bool]$Condition, [string]$Message)
    $script:checks += 1
    if (-not $Condition) { throw "FAILED: $Message" }
}
function Assert-RuntimeThrows {
    param([scriptblock]$Action, [string]$Message)
    $thrown = $false
    try { & $Action } catch { $thrown = $true }
    Assert-Runtime $thrown $Message
}

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('nino-runtime-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $scratch)
try {
    $script:downloadBytes = [Text.Encoding]::UTF8.GetBytes('verified-runtime-fixture')
    $fixture = Join-Path $scratch 'expected.bin'
    [IO.File]::WriteAllBytes($fixture, $script:downloadBytes)
    $hash = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
    $package = [pscustomobject]@{ version = '9.0.2'; archiveRoot = 'ffmpeg-9.0.2-essentials_build';
        url = 'https://github.com/nino-test-fixtures/not-downloaded/runtime.zip'; sha256 = $hash; source = 'https://github.com/nino-test-fixtures/not-downloaded' }
    $script:networkCalls = 0
    $script:networkFails = $false
    function Invoke-WebRequest {
        param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
        $script:networkCalls += 1
        if ($script:networkFails) { throw 'simulated download failure' }
        [IO.File]::WriteAllBytes($OutFile, $script:downloadBytes)
    }
    $downloads = Join-Path $scratch 'downloads'
    $download = Get-NinoDownload -Package $package -Directory $downloads -Suffix '.zip'
    Assert-Runtime (Test-Path -LiteralPath $download -PathType Leaf) 'verified download is available'
    Assert-Runtime ($script:networkCalls -eq 1) 'one simulated download'
    Assert-Runtime ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -eq $hash) 'download matches pinned SHA-256'
    Assert-Runtime ((Get-NinoDownload -Package $package -Directory $downloads -Suffix '.zip') -eq $download) 'verified cache reused'
    Assert-Runtime ($script:networkCalls -eq 1) 'verified cache requires no network'

    foreach ($url in @('http://github.com/runtime.zip', 'file:///tmp/runtime.zip', 'https://',
                        'https://example.invalid/runtime.zip', 'https://user@github.com/runtime.zip',
                        'https://github.com/runtime.zip#fragment')) {
        $package.url = $url
        Assert-RuntimeThrows { Get-NinoDownload -Package $package -Directory $downloads -Suffix '.zip' } 'non-HTTPS URL rejected'
    }
    Assert-Runtime ($script:networkCalls -eq 1) 'invalid transport never contacts network'
    $package.url = 'https://github.com/nino-test-fixtures/not-downloaded/runtime.zip'
    $package.sha256 = 'not-a-sha256'
    Assert-RuntimeThrows { Get-NinoDownload -Package $package -Directory $downloads -Suffix '.zip' } 'invalid digest rejected'
    Assert-Runtime ($script:networkCalls -eq 1) 'invalid digest never contacts network'
    $package.sha256 = $hash
    [IO.File]::WriteAllText($download, 'corrupt cache')
    $script:downloadBytes = [Text.Encoding]::UTF8.GetBytes('tampered download')
    Assert-RuntimeThrows { Get-NinoDownload -Package $package -Directory $downloads -Suffix '.zip' } 'mismatched bytes never become verified cache'
    Assert-Runtime (@(Get-ChildItem -LiteralPath $downloads -Filter '*.partial').Count -eq 0) 'failed verification cleans partial download'
    $script:networkFails = $true
    Assert-RuntimeThrows { Get-NinoDownload -Package $package -Directory $downloads -Suffix '.zip' } 'network failure fails clearly'
    Assert-Runtime (@(Get-ChildItem -LiteralPath $downloads -Filter '*.partial').Count -eq 0) 'network failure cleans partial download'

    # Exercise real ZIP path checks with small inert archives.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    function New-RuntimeFixtureZip {
        param([string]$Name, [string]$Entry)
        $path = Join-Path $scratch $Name
        $archive = [IO.Compression.ZipFile]::Open($path, [IO.Compression.ZipArchiveMode]::Create)
        try {
            $entryStream = $archive.CreateEntry($Entry).Open()
            try { $entryStream.WriteByte(65) } finally { $entryStream.Dispose() }
        } finally { $archive.Dispose() }
        return $path
    }
    $number = 0
    foreach ($entry in @('../escape.txt', '/escape.txt', 'C:/escape.txt', 'safe/../escape.txt', 'safe\..\escape.txt')) {
        $number += 1
        $zip = New-RuntimeFixtureZip -Name ("unsafe-$number.zip") -Entry $entry
        Assert-RuntimeThrows { Expand-NinoVerifiedZip -Archive $zip -Destination (Join-Path $scratch "unsafe-$number") } "reject archive path $entry"
    }
    Assert-Runtime (-not (Test-Path -LiteralPath (Join-Path $scratch 'escape.txt'))) 'no archive wrote outside extraction destination'
    $zip = New-RuntimeFixtureZip -Name 'safe.zip' -Entry 'runtime/bin/readme.txt'
    $destination = Join-Path $scratch 'safe'
    Expand-NinoVerifiedZip -Archive $zip -Destination $destination
    Assert-Runtime ((Get-Content -LiteralPath (Join-Path $destination 'runtime/bin/readme.txt') -Raw) -eq 'A') 'safe archive extracts normally'

    # A receipt alone cannot bypass binary integrity verification. This branch
    # returns before any process execution, so text files suffice as binaries.
    $runtimeRoot = Join-Path $scratch 'user'
    $installed = Join-Path $runtimeRoot 'runtime/ffmpeg/9.0.2'
    [void](New-Item -ItemType Directory -Path (Join-Path $installed 'bin') -Force)
    $ffmpeg = Join-Path $installed 'bin/ffmpeg.exe'
    $ffprobe = Join-Path $installed 'bin/ffprobe.exe'
    [IO.File]::WriteAllText($ffmpeg, 'inert-ffmpeg-fixture')
    [IO.File]::WriteAllText($ffprobe, 'inert-ffprobe-fixture')
    $receipt = Join-Path $installed 'nino-runtime.json'
    [ordered]@{ archiveSha256 = $hash;
        ffmpegSha256 = (Get-FileHash -LiteralPath $ffmpeg -Algorithm SHA256).Hash.ToLowerInvariant();
        ffprobeSha256 = (Get-FileHash -LiteralPath $ffprobe -Algorithm SHA256).Hash.ToLowerInvariant()
    } | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
    $script:repairDownloads = 0
    function Get-NinoDownload {
        param($Package, $Directory, $Suffix)
        $script:repairDownloads += 1
        throw 'Repair download intercepted by test'
    }
    Initialize-NinoFfmpeg -Package $package -Root $runtimeRoot
    Assert-Runtime ($script:repairDownloads -eq 0) 'matching receipt and actual binary hashes are idempotent'
    [IO.File]::WriteAllText($ffprobe, 'tampered')
    Assert-RuntimeThrows { Initialize-NinoFfmpeg -Package $package -Root $runtimeRoot } 'changed ffprobe requests verified repair'
    Assert-Runtime ($script:repairDownloads -eq 1) 'changed binary cannot reuse receipt'
    '{' | Set-Content -LiteralPath $receipt -Encoding UTF8
    Assert-RuntimeThrows { Initialize-NinoFfmpeg -Package $package -Root $runtimeRoot } 'truncated receipt requests verified repair'
    Assert-Runtime ($script:repairDownloads -eq 2) 'invalid receipt is recoverable without trusting its contents'
    $package.version = '../outside'
    Assert-RuntimeThrows { Initialize-NinoFfmpeg -Package $package -Root $runtimeRoot } 'version cannot escape runtime directory'
    Assert-Runtime ($script:repairDownloads -eq 2) 'invalid version cannot start download or write runtime'
    $package.version = '9.0.2'
    $package.archiveRoot = '../outside'
    Assert-RuntimeThrows { Initialize-NinoFfmpeg -Package $package -Root $runtimeRoot } 'archive root cannot escape staging directory'
    Assert-Runtime ($script:repairDownloads -eq 2) 'invalid archive root cannot start download or write runtime'

    # Exercise the full staging/receipt branch with inert local files and a
    # redirected-output process stub. stderr text alone must not be a failure.
    $package.archiveRoot = 'ffmpeg-9.0.2-essentials_build'
    $script:archiveFolder = $package.archiveRoot
    $script:nativeCode = 0
    $script:encoderText = ' V..... libx264 H.264 encoder; A..... aac AAC encoder'
    $script:nativeCalls = 0
    function Get-NinoDownload { param($Package, $Directory, $Suffix); return $fixture }
    function Expand-NinoVerifiedZip {
        param($Archive, $Destination)
        $bin = Join-Path $Destination ($script:archiveFolder + '/bin')
        [void](New-Item -ItemType Directory -Path $bin -Force)
        [IO.File]::WriteAllText((Join-Path $bin 'ffmpeg.exe'), 'staged-ffmpeg-fixture')
        [IO.File]::WriteAllText((Join-Path $bin 'ffprobe.exe'), 'staged-ffprobe-fixture')
    }
    function Start-Process {
        param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError)
        $script:nativeCalls += 1
        if (-not $Wait -or -not $PassThru -or -not $RedirectStandardOutput -or -not $RedirectStandardError) {
            throw 'Native fixture requires explicit exit status and separately redirected streams'
        }
        [IO.File]::WriteAllText($RedirectStandardOutput, $script:encoderText)
        [IO.File]::WriteAllText($RedirectStandardError, 'Harmless native diagnostic on stderr')
        return [pscustomobject]@{ ExitCode = $script:nativeCode }
    }
    $freshRoot = Join-Path $scratch 'fresh-install'
    Initialize-NinoFfmpeg -Package $package -Root $freshRoot
    $freshInstall = Join-Path $freshRoot 'runtime/ffmpeg/9.0.2'
    $freshReceipt = Get-Content -LiteralPath (Join-Path $freshInstall 'nino-runtime.json') -Raw | ConvertFrom-Json
    Assert-Runtime ($script:nativeCalls -eq 1) 'encoder check uses explicit native process status'
    Assert-Runtime ($freshReceipt.archiveSha256 -eq $hash) 'new installation records pinned archive digest'
    Assert-Runtime ($freshReceipt.ffmpegSha256 -eq (Get-FileHash -LiteralPath (Join-Path $freshInstall 'bin/ffmpeg.exe') -Algorithm SHA256).Hash.ToLowerInvariant()) 'new receipt records actual encoder digest'
    Assert-Runtime ($freshReceipt.ffprobeSha256 -eq (Get-FileHash -LiteralPath (Join-Path $freshInstall 'bin/ffprobe.exe') -Algorithm SHA256).Hash.ToLowerInvariant()) 'new receipt records actual probe digest'
    Assert-Runtime (@(Get-ChildItem -LiteralPath (Join-Path $freshRoot 'runtime/ffmpeg') -Filter '.prepare-*').Count -eq 0) 'successful staging directory cleaned'
    $script:nativeCode = 1
    $failedRoot = Join-Path $scratch 'native-failure'
    Assert-RuntimeThrows { Initialize-NinoFfmpeg -Package $package -Root $failedRoot } 'native nonzero exit rejects runtime'
    Assert-Runtime (-not (Test-Path -LiteralPath (Join-Path $failedRoot 'runtime/ffmpeg/9.0.2'))) 'failed native check never publishes runtime'
    Assert-Runtime (@(Get-ChildItem -LiteralPath (Join-Path $failedRoot 'runtime/ffmpeg') -Filter '.prepare-*').Count -eq 0) 'failed native check cleans staging'
    $script:nativeCode = 0
    $script:encoderText = ' V..... h264_other; A..... aac'
    Assert-RuntimeThrows { Initialize-NinoFfmpeg -Package $package -Root (Join-Path $scratch 'missing-encoder') } 'missing libx264 rejects runtime even with zero exit'

    Write-Host "Runtime regression checks passed: $script:checks"
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
