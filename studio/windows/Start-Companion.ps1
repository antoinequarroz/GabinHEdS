#requires -Version 5.1
<#
  Current-user Companion startup. Uses an existing Companion installation only.
  Nino starts in the background so the authenticated "Open studio" button can
  open the room later. Neither this script nor the launcher starts REC or live.
#>
[CmdletBinding()]
param(
    [switch]$Startup,
    [switch]$Configure,
    [switch]$EnableStartup,
    [switch]$DisableStartup,
    [switch]$RemoveStartup,
    [switch]$NoDialogs
)

function Get-NinoCompanionLayout {
    param([Parameter(Mandatory = $true)][string]$LauncherDirectory,
          [Parameter(Mandatory = $true)][string]$LocalAppData,
          [Parameter(Mandatory = $true)][string]$StartupDirectory)
    $install = [IO.Path]::GetFullPath((Join-Path $LauncherDirectory '..'))
    $userRoot = Join-Path $LocalAppData 'Nino'
    return [pscustomobject]@{
        InstallRoot = $install
        UserRoot = $userRoot
        ScriptPath = Join-Path $install 'windows/Start-Companion.ps1'
        StudioLauncher = Join-Path $install 'windows/Launch-Nino.ps1'
        IconPath = Join-Path $install 'windows/nino.ico'
        SettingsPath = Join-Path $userRoot 'companion-settings.json'
        LogRoot = Join-Path $userRoot 'logs'
        StartupLink = Join-Path $StartupDirectory 'Nino - Companion.lnk'
        PowerShellPath = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
    }
}

function ConvertTo-NinoCompanionArgument {
    param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Get-NinoCompanionStartupArguments {
    param([Parameter(Mandatory = $true)]$Layout)
    return '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
        $Layout.ScriptPath + '" -Startup -NoDialogs'
}

function Resolve-NinoCompanionExecutable {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$MustExist)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path) -or
        $Path.StartsWith('\\') -or $Path -match '[\x00-\x1f"]' -or
        -not [string]::Equals([IO.Path]::GetFileName($Path), 'Companion.exe', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Choisissez le fichier local Companion.exe installe par Bitfocus, sans ajouter de commande ni argument.'
    }
    $resolved = [IO.Path]::GetFullPath($Path)
    if ($MustExist -and -not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Companion est introuvable : $resolved. Utilisez Configurer Companion dans le menu Demarrer."
    }
    return $resolved
}

function Get-NinoCompanionSettings {
    param([Parameter(Mandatory = $true)][string]$Path)
    $settings = [pscustomobject]@{ ExecutablePath = $null; StartupEnabled = $false }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $settings }
    try {
        $source = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if (-not $source.TrimStart().StartsWith('{')) { throw 'JSON object required' }
        $saved = $source | ConvertFrom-Json
        if ($null -eq $saved -or $saved -isnot [pscustomobject] -or $saved -is [array]) { throw 'JSON object required' }
        foreach ($key in $saved.PSObject.Properties.Name) {
            if ($key -notin @('schemaVersion', 'executablePath', 'startupEnabled')) { throw 'Unknown setting' }
        }
        if ($saved.schemaVersion -ne 1 -or $saved.startupEnabled -isnot [bool]) { throw 'Invalid settings' }
        if ($null -ne $saved.executablePath) {
            if ($saved.executablePath -isnot [string]) { throw 'Invalid executable' }
            $settings.ExecutablePath = Resolve-NinoCompanionExecutable -Path $saved.executablePath
        }
        $settings.StartupEnabled = $saved.startupEnabled
    } catch { throw "Les reglages Companion sont invalides : $Path. Aucun programme n'a ete lance." }
    return $settings
}

function Save-NinoCompanionSettings {
    param([Parameter(Mandatory = $true)][string]$Path,
          [AllowNull()][string]$ExecutablePath,
          [Parameter(Mandatory = $true)][bool]$StartupEnabled)
    $savedPath = $null
    if ($ExecutablePath) { $savedPath = Resolve-NinoCompanionExecutable -Path $ExecutablePath }
    [void](New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force)
    $saved = [ordered]@{ schemaVersion = 1; executablePath = $savedPath; startupEnabled = $StartupEnabled }
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($saved | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Get-NinoCompanionCandidates {
    $candidates = @()
    foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\Companion.exe',
                            'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\Companion.exe')) {
        $key = Get-Item -LiteralPath $registry -ErrorAction SilentlyContinue
        if ($null -ne $key) { $candidates += $key.GetValue('') }
    }
    if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'Companion/Companion.exe' }
    if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'Companion/Companion.exe' }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs/Companion/Companion.exe' }
    return $candidates
}

function Find-NinoCompanionExecutable {
    param([AllowNull()][string]$ConfiguredPath)
    if ($ConfiguredPath) { return Resolve-NinoCompanionExecutable -Path $ConfiguredPath -MustExist }
    foreach ($candidate in @(Get-NinoCompanionCandidates)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
            try { return Resolve-NinoCompanionExecutable -Path ([string]$candidate) -MustExist } catch { continue }
        }
    }
    return $null
}

function Get-NinoCompanionShortcut {
    param([Parameter(Mandatory = $true)][string]$Path)
    $shell = New-Object -ComObject WScript.Shell
    try {
        $link = $shell.CreateShortcut($Path)
        return [pscustomobject]@{
            TargetPath = [string]$link.TargetPath; Arguments = [string]$link.Arguments
            WorkingDirectory = [string]$link.WorkingDirectory; Description = [string]$link.Description
        }
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}

function Test-NinoCompanionOwnedShortcut {
    param([Parameter(Mandatory = $true)]$Shortcut,
          [Parameter(Mandatory = $true)]$Layout)
    return [string]::Equals($Shortcut.TargetPath, $Layout.PowerShellPath, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($Shortcut.WorkingDirectory, $Layout.InstallRoot, [StringComparison]::OrdinalIgnoreCase) -and
        $Shortcut.Arguments -ceq (Get-NinoCompanionStartupArguments -Layout $Layout) -and
        $Shortcut.Description -ceq 'Nino Companion startup (owned by Nino)'
}

function Save-NinoCompanionShortcut {
    param([Parameter(Mandatory = $true)]$Layout)
    [void](New-Item -ItemType Directory -Path (Split-Path -Parent $Layout.StartupLink) -Force)
    $shell = New-Object -ComObject WScript.Shell
    try {
        $link = $shell.CreateShortcut($Layout.StartupLink)
        $link.TargetPath = $Layout.PowerShellPath
        $link.Arguments = Get-NinoCompanionStartupArguments -Layout $Layout
        $link.WorkingDirectory = $Layout.InstallRoot
        $link.Description = 'Nino Companion startup (owned by Nino)'
        $link.IconLocation = $Layout.IconPath + ',0'
        $link.WindowStyle = 7
        $link.Save()
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}

function Set-NinoCompanionStartup {
    param([Parameter(Mandatory = $true)]$Layout,
          [Parameter(Mandatory = $true)][bool]$Enabled)
    if (Test-Path -LiteralPath $Layout.StartupLink -PathType Leaf) {
        $existing = Get-NinoCompanionShortcut -Path $Layout.StartupLink
        if (-not (Test-NinoCompanionOwnedShortcut -Shortcut $existing -Layout $Layout)) {
            throw 'Un autre raccourci porte deja le nom Nino - Companion. Il a ete conserve ; renommez-le manuellement avant de configurer le demarrage Nino.'
        }
    } elseif (-not $Enabled) { return }
    if (-not $Enabled) {
        Remove-Item -LiteralPath $Layout.StartupLink -Force
        return
    }
    Save-NinoCompanionShortcut -Layout $Layout
}

function Get-NinoCompanionProcesses {
    return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Companion.exe'" -ErrorAction Stop)
}

function Test-NinoCompanionHttpHealth {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/' -UseBasicParsing -TimeoutSec 2 -MaximumRedirection 0 -ErrorAction Stop
        return $response.StatusCode -eq 200 -and
            $response.Content -match '(?is)<title>\s*Bitfocus Companion\b'
    } catch { return $false }
}

function Wait-NinoCompanionHttpHealth {
    param([int]$TimeoutSeconds = 45)
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-NinoCompanionHttpHealth) { return }
        Start-Sleep -Milliseconds 500
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'Companion est ouvert, mais son serveur ne repond pas sur http://127.0.0.1:8000/. Verifiez les reglages du port et de l interface reseau ainsi que les erreurs affichees par Companion, puis relancez-le. Terminez ce premier reglage avant le prochain demarrage Windows.'
}

function Start-NinoCompanionStudio {
    param([Parameter(Mandatory = $true)]$Layout)
    if (-not (Test-Path -LiteralPath $Layout.StudioLauncher -PathType Leaf)) { throw 'Le lanceur Nino manque. Relancez l installateur Nino.' }
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Layout.StudioLauncher,
        '-NoBrowser', '-NoObs', '-NoDialogs')
    $line = ($arguments | ForEach-Object { ConvertTo-NinoCompanionArgument -Value $_ }) -join ' '
    $process = Start-Process -FilePath $Layout.PowerShellPath -ArgumentList $line -WorkingDirectory $Layout.InstallRoot `
        -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
    if ($process.ExitCode -ne 0) { throw 'Nino ne peut pas demarrer en arriere-plan. Consultez les journaux Nino ; aucun enregistrement ou live n a ete lance.' }
}

function Start-NinoCompanionApplication {
    param([Parameter(Mandatory = $true)][string]$ExecutablePath,
          [Parameter(Mandatory = $true)]$Layout)
    $executable = Resolve-NinoCompanionExecutable -Path $ExecutablePath -MustExist
    $running = @(Get-NinoCompanionProcesses)
    foreach ($process in $running) {
        if (-not [string]::Equals([string]$process.ExecutablePath, $executable, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Une autre instance de Companion est deja ouverte, ou son chemin est inaccessible. Aucun programme n a ete ferme. Verifiez Companion avant de reessayer.'
        }
    }
    Start-NinoCompanionStudio -Layout $Layout
    if ($running.Count -gt 0) {
        Write-Host 'Companion est deja ouvert. Verification de son serveur...'
    } else {
        [void](Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable) -PassThru -ErrorAction Stop)
        Write-Host 'Companion est ouvert. Verification de son serveur...'
    }
    Wait-NinoCompanionHttpHealth
    Write-Host 'Le serveur Companion repond et Nino est pret en arriere-plan. Aucun enregistrement ni live n a ete lance.'
}

function Show-NinoCompanionConfiguration {
    param([Parameter(Mandatory = $true)]$Layout)
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $settings = Get-NinoCompanionSettings -Path $Layout.SettingsPath
    $detected = Find-NinoCompanionExecutable -ConfiguredPath $null
    $form = New-Object Windows.Forms.Form
    $form.Text = 'Nino - Configurer Companion'
    $form.Size = New-Object Drawing.Size(650, 330)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $intro = New-Object Windows.Forms.Label
    $intro.Text = "Choisissez Companion deja installe sur ce PC. Nino ne telecharge et n'installe pas Companion.`r`nA l'ouverture de session, Nino reste en arriere-plan puis Companion s'ouvre. Aucun REC/live."
    $intro.SetBounds(20, 20, 600, 50)
    $path = New-Object Windows.Forms.TextBox
    $path.ReadOnly = $true
    $path.SetBounds(20, 80, 470, 25)
    $path.Text = if ($settings.ExecutablePath) { $settings.ExecutablePath } elseif ($detected) { $detected } else { '' }
    $choose = New-Object Windows.Forms.Button
    $choose.Text = 'Choisir...'
    $choose.SetBounds(500, 78, 115, 28)
    $choose.Add_Click({
        $picker = New-Object Windows.Forms.OpenFileDialog
        $picker.Title = 'Choisir le programme Companion.exe'
        $picker.Filter = 'Companion.exe|Companion.exe'
        $picker.CheckFileExists = $true
        try { if ($picker.ShowDialog($form) -eq [Windows.Forms.DialogResult]::OK) { $path.Text = $picker.FileName } }
        finally { $picker.Dispose() }
    }.GetNewClosure())
    $startupOption = New-Object Windows.Forms.CheckBox
    $startupOption.Text = 'Ouvrir Companion automatiquement a ma connexion Windows'
    $startupOption.Checked = $settings.StartupEnabled
    $startupOption.SetBounds(20, 120, 600, 28)
    $download = New-Object Windows.Forms.LinkLabel
    $download.Text = 'Companion absent ? Ouvrir le site officiel pour l installer.'
    $download.SetBounds(20, 155, 600, 25)
    $download.Add_LinkClicked({ [void](Start-Process 'https://user.bitfocus.io/download') })
    $save = New-Object Windows.Forms.Button
    $save.Text = 'Enregistrer'
    $save.SetBounds(330, 220, 135, 32)
    $open = New-Object Windows.Forms.Button
    $open.Text = 'Enregistrer et ouvrir'
    $open.SetBounds(475, 220, 140, 32)
    $persist = {
        if ($startupOption.Checked -and -not $path.Text) { throw 'Choisissez Companion.exe. Si Companion n est pas installe, utilisez le lien vers son site officiel.' }
        $selected = $null
        if ($path.Text) { $selected = Resolve-NinoCompanionExecutable -Path $path.Text -MustExist:$startupOption.Checked }
        Set-NinoCompanionStartup -Layout $Layout -Enabled $startupOption.Checked
        Save-NinoCompanionSettings -Path $Layout.SettingsPath -ExecutablePath $selected -StartupEnabled $startupOption.Checked
    }.GetNewClosure()
    $save.Add_Click({
        try { & $persist; $form.Close() }
        catch { [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Nino', 'OK', 'Error') }
    }.GetNewClosure())
    $open.Add_Click({
        try { & $persist; Start-NinoCompanionApplication -ExecutablePath $path.Text -Layout $Layout; $form.Close() }
        catch { [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Nino', 'OK', 'Error') }
    }.GetNewClosure())
    $form.Controls.AddRange(@($intro, $path, $choose, $startupOption, $download, $save, $open))
    try { [void]$form.ShowDialog() } finally { $form.Dispose() }
}

function Invoke-NinoCompanion {
    param([Parameter(Mandatory = $true)][string]$LauncherDirectory,
          [switch]$Startup, [switch]$Configure, [switch]$EnableStartup,
          [switch]$DisableStartup, [switch]$RemoveStartup, [switch]$NoDialogs)
    $ErrorActionPreference = 'Stop'
    $layout = $null
    $mutex = $null
    $locked = $false
    try {
        if ($env:OS -ne 'Windows_NT' -or -not $env:LOCALAPPDATA) { throw 'Ce raccourci est reserve au PC Windows 11 de la salle.' }
        $modes = @($Startup, $Configure, $EnableStartup, $DisableStartup, $RemoveStartup | Where-Object { $_ })
        if ($modes.Count -gt 1) { throw 'Choisissez un seul mode Companion.' }
        $layout = Get-NinoCompanionLayout -LauncherDirectory $LauncherDirectory -LocalAppData $env:LOCALAPPDATA `
            -StartupDirectory ([Environment]::GetFolderPath('Startup'))
        [void](New-Item -ItemType Directory -Path $layout.LogRoot -Force)
        if ($Configure) { Show-NinoCompanionConfiguration -Layout $layout; return 0 }
        $mutex = New-Object Threading.Mutex($false, 'Local\Nino.Companion.Startup')
        try { $locked = $mutex.WaitOne(120000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Un demarrage Companion est deja en cours. Patientez puis reessayez.' }
        if ($RemoveStartup) { Set-NinoCompanionStartup -Layout $layout -Enabled $false; return 0 }
        $settings = Get-NinoCompanionSettings -Path $layout.SettingsPath
        if ($EnableStartup -or $DisableStartup) {
            Set-NinoCompanionStartup -Layout $layout -Enabled ([bool]$EnableStartup)
            Save-NinoCompanionSettings -Path $layout.SettingsPath -ExecutablePath $settings.ExecutablePath -StartupEnabled ([bool]$EnableStartup)
            return 0
        }
        if ($Startup -and -not $settings.StartupEnabled) { return 0 }
        $executable = Find-NinoCompanionExecutable -ConfiguredPath $settings.ExecutablePath
        if (-not $executable) {
            throw 'Companion n est pas installe ou son chemin est inconnu. Ouvrez Configurer Companion dans le menu Demarrer > Nino. Aucun logiciel tiers n a ete telecharge.'
        }
        Start-NinoCompanionApplication -ExecutablePath $executable -Layout $layout
        return 0
    } catch {
        $message = $_.Exception.Message
        Write-Warning $message
        if ($null -ne $layout) {
            try { ('{0:o} {1}' -f [datetime]::UtcNow, $message) | Add-Content -LiteralPath (Join-Path $layout.LogRoot 'companion-launcher.log') -Encoding UTF8 }
            catch { Write-Warning 'Le journal Companion est indisponible.' }
        }
        if (-not $NoDialogs) {
            try { Add-Type -AssemblyName System.Windows.Forms; [void][Windows.Forms.MessageBox]::Show($message, 'Nino - Companion', 'OK', 'Error') }
            catch { Write-Warning 'Consultez les journaux Nino pour terminer la configuration.' }
        }
        return 1
    } finally {
        if ($locked -and $null -ne $mutex) { $mutex.ReleaseMutex() }
        if ($null -ne $mutex) { $mutex.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-NinoCompanion -LauncherDirectory $PSScriptRoot -Startup:$Startup -Configure:$Configure `
        -EnableStartup:$EnableStartup -DisableStartup:$DisableStartup -RemoveStartup:$RemoveStartup -NoDialogs:$NoDialogs
    exit $result
}
