; Compile only from the verified Windows payload produced by the release builder.
; Application binaries and user data deliberately live in different directories.
#ifndef NinoPayloadDir
  #error NinoPayloadDir must point to the prepared Windows payload directory.
#endif
#ifndef NinoOutputDir
  #error NinoOutputDir must point to the installer output directory.
#endif
#ifndef NinoVersion
  #define NinoVersion "0.1.0"
#endif
#ifndef NinoSourceRevision
  #define NinoSourceRevision "local"
#endif

#if !FileExists(NinoPayloadDir + "\runtime\node\node.exe")
  #error The verified Windows Node.js runtime is missing.
#endif
#if !FileExists(NinoPayloadDir + "\windows\Prepare-Runtime.ps1")
  #error The verified video runtime preparation script is missing.
#endif
#if !FileExists(NinoPayloadDir + "\windows\runtime-lock.json")
  #error The pinned video runtime download manifest is missing.
#endif
#if !FileExists(NinoPayloadDir + "\runtime\mediamtx\mediamtx.exe")
  #error The verified Windows MediaMTX runtime is missing.
#endif
#if !FileExists(NinoPayloadDir + "\app\apps\web\dist\index.html")
  #error The compiled Nino web interface is missing.
#endif
#if !FileExists(NinoPayloadDir + "\windows\Launch-Nino.ps1") || !FileExists(NinoPayloadDir + "\windows\nino.ico")
  #error The Nino launcher or icon is missing.
#endif
#if !FileExists(NinoPayloadDir + "\app\docs\guides\nino-installation-salle.pdf")
  #error The room installation guide is missing.
#endif

[Setup]
AppId={{B1890C72-62B2-4A38-BE95-7B7055A4969A}
AppName=Nino
AppVersion={#NinoVersion}
AppVerName=Nino {#NinoVersion}
AppPublisher=Nino
AppSupportURL=https://github.com/antoinequarroz/GabinHEdS/issues
AppUpdatesURL=https://github.com/antoinequarroz/GabinHEdS/releases
VersionInfoDescription=Nino — installation du studio
VersionInfoProductName=Nino
VersionInfoVersion={#NinoVersion}
DefaultDirName={localappdata}\Programs\Nino
DefaultGroupName=Nino
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
WizardStyle=modern dark
WizardSizePercent=110
SetupIconFile={#NinoPayloadDir}\windows\nino.ico
UninstallDisplayIcon={app}\windows\nino.ico
OutputDir={#NinoOutputDir}
OutputBaseFilename=Nino-Setup-{#NinoVersion}-{#NinoSourceRevision}-windows-x64
Compression=lzma2
SolidCompression=yes
LZMANumBlockThreads=2
SetupLogging=yes
UninstallLogging=yes
; Never let Restart Manager close a studio process during an update or removal.
CloseApplications=no
RestartApplications=no
AppMutex=NinoStudio.Windows.Launcher
SetupMutex=NinoStudio.Windows.Setup

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Messages]
WelcomeLabel2=Ce programme installe Nino, Node.js et MediaMTX pour votre compte Windows. Une connexion Internet est nécessaire à la première préparation : FFmpeg est téléchargé depuis sa distribution référencée et vérifié, puis conservé sur ce PC.%n%nSi OBS est déjà installé, Nino le réutilise. Sinon, une option ouvre son installation officielle à la fin. Le pilote RØDE reste à installer séparément.%n%nAvant une mise à jour, terminez l’enregistrement et le live, puis arrêtez Nino depuis sa fenêtre de lancement.
FinishedLabel=La préparation des outils vidéo a été effectuée dans une fenêtre séparée. Vous pouvez lancer le studio avec le raccourci « Nino + OBS ». Les caméras, les micros et la connexion OBS se règlent ensuite dans Nino, avec le guide de la salle.%n%nVos productions et vos réglages sont conservés en dehors du dossier du logiciel.

[Tasks]
Name: "desktopicon"; Description: "Créer le raccourci Nino + OBS sur le Bureau"; GroupDescription: "Raccourcis :"

[Dirs]
; The uninstaller must preserve diagnostics together with the user's productions.
Name: "{localappdata}\Nino\logs"; Flags: uninsneveruninstall

[Files]
; The builder supplies an allowlisted payload. These exclusions add a final guard
; against accidentally shipping a developer database, recording or secret.
Source: "{#NinoPayloadDir}\*"; DestDir: "{app}"; Excludes: "\runtime\ffmpeg\*,.data\*,.env,.env.*,*.sqlite,*.sqlite-*,*.db,*.log,*.mp4,*.mkv,*.mov,*.webm,*.wav,*.mp3,*.m4a,*.aac"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Nino + OBS"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\Launch-Nino.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\windows\nino.ico"; Comment: "Ouvrir Nino et OBS pour préparer une production"
Name: "{autodesktop}\Nino + OBS"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\Launch-Nino.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\windows\nino.ico"; Comment: "Ouvrir Nino et OBS pour préparer une production"; Tasks: desktopicon
Name: "{group}\Arrêter Nino"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\Launch-Nino.ps1"" -Stop"; WorkingDir: "{app}"; IconFilename: "{app}\windows\nino.ico"; Comment: "Arrêter les composants Nino après la production, sans fermer OBS"
Name: "{group}\Guide installation salle"; Filename: "{app}\app\docs\guides\nino-installation-salle.pdf"; WorkingDir: "{app}\app\docs\guides"
Name: "{group}\Journaux Nino"; Filename: "{localappdata}\Nino\logs"
Name: "{group}\Désinstaller Nino"; Filename: "{uninstallexe}"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\Prepare-Runtime.ps1"" -DataRoot ""{localappdata}\Nino"" -InstallOBS -OnlyOBS"; WorkingDir: "{app}"; Description: "Installer OBS depuis son installateur officiel si nécessaire (Internet requis)"; Flags: postinstall skipifsilent unchecked
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\Launch-Nino.ps1"""; WorkingDir: "{app}"; Description: "Lancer Nino + OBS"; Flags: postinstall nowait skipifsilent unchecked

[Code]
var
  VideoPreparationFailed: Boolean;

function InstalledRuntimeIsRunning: Boolean;
var
  Locator, Services, Processes, Process: Variant;
  I: Integer;
  ExecutablePath, RuntimeDirectory, UserRuntimeDirectory: String;
begin
  Result := False;
  RuntimeDirectory := Lowercase(AddBackslash(ExpandConstant('{app}\runtime')));
  UserRuntimeDirectory := Lowercase(AddBackslash(ExpandConstant('{localappdata}\Nino\runtime')));
  if not DirExists(RuntimeDirectory) and not DirExists(UserRuntimeDirectory) then
    exit;

  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('.', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT ExecutablePath FROM Win32_Process WHERE ' +
      'Name = ''node.exe'' OR Name = ''mediamtx.exe'' OR Name = ''ffmpeg.exe'' OR Name = ''ffprobe.exe''');
    for I := 0 to Processes.Count - 1 do
    begin
      Process := Processes.ItemIndex(I);
      if not VarIsNull(Process.ExecutablePath) then
      begin
        ExecutablePath := Process.ExecutablePath;
        ExecutablePath := Lowercase(ExecutablePath);
        if (Pos(RuntimeDirectory, ExecutablePath) = 1) or
           (Pos(UserRuntimeDirectory, ExecutablePath) = 1) then
        begin
          Result := True;
          exit;
        end;
      end;
    end;
  except
    ; Refuse an update when Windows cannot establish that bundled runtimes stopped.
    Log('Impossible de vérifier les processus Nino : ' + GetExceptionMessage);
    Result := True;
  end;
end;

function RunningStudioMessage: String;
begin
  Result := 'Nino utilise encore ses composants vidéo ou son serveur. ' +
    'Terminez l''enregistrement et le live, puis arrêtez Nino depuis sa fenêtre de lancement. ' +
    'Réessayez ensuite. Aucun processus OBS ou Nino ne sera fermé automatiquement.';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if InstalledRuntimeIsRunning then
    Result := RunningStudioMessage;
end;

function InitializeUninstall: Boolean;
begin
  Result := not InstalledRuntimeIsRunning;
  if not Result then
    SuppressibleMsgBox(RunningStudioMessage, mbError, MB_OK, IDOK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PreparationExitCode: Integer;
  PreparationParameters: String;
begin
  ; A silent installation is useful for deployment and CI; the launcher performs
  ; the same verified preparation before starting any production components.
  if (CurStep = ssPostInstall) and not WizardSilent then
  begin
    PreparationParameters := '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\windows\Prepare-Runtime.ps1') + '" -DataRoot "' +
      ExpandConstant('{localappdata}\Nino') + '"';
    VideoPreparationFailed := not Exec(
      ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      PreparationParameters, ExpandConstant('{app}'), SW_SHOWNORMAL,
      ewWaitUntilTerminated, PreparationExitCode);
    if not VideoPreparationFailed then
      VideoPreparationFailed := PreparationExitCode <> 0;
    if VideoPreparationFailed then
    begin
      Log('La préparation des outils vidéo a échoué. Code : ' + IntToStr(PreparationExitCode));
      MsgBox('Nino est installé, mais ses outils vidéo ne sont pas encore prêts. ' +
        'Vérifiez la connexion Internet, puis utilisez le raccourci « Nino + OBS » ' +
        'pour réessayer la préparation. Ne commencez pas une production avant sa réussite.',
        mbError, MB_OK);
    end;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and VideoPreparationFailed then
    WizardForm.FinishedLabel.Caption :=
      'Nino est installé, mais la préparation des outils vidéo a échoué. ' +
      'Vérifiez la connexion Internet, puis relancez « Nino + OBS » pour réessayer.' + #13#10#13#10 +
      'Les caméras, les micros et la connexion OBS se règlent ensuite avec le guide de la salle. ' +
      'Vos productions et vos réglages restent conservés en dehors du dossier du logiciel.';
end;

; No UninstallDelete or registry edits: OBS profiles, device pairing, productions
; and everything below %LOCALAPPDATA%\Nino remain intact after uninstalling Nino.
