; Whooptido ASR Captions — Windows Installer (Inno Setup)
; Builds a proper Setup wizard that installs the companion binary,
; creates the NM manifest, and registers the Chrome native messaging host.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppName=Whooptido ASR Captions
AppVersion={#AppVersion}
AppPublisher=Whooptido
AppPublisherURL=https://whooptido.com
AppSupportURL=https://github.com/Whooptido-App/ASR-Captions
DefaultDirName={localappdata}\Whooptido
OutputBaseFilename=whooptido-asr-captions-windows-x64-setup
Compression=lzma
SolidCompression=yes
PrivilegesRequired=lowest
UninstallDisplayName=Whooptido ASR Captions
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableWelcomePage=no
WizardStyle=modern
OutputDir=..\Output
; No start menu or desktop shortcut — this is a background service
CreateUninstallRegKey=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist\whooptido-asr-captions-windows-x64.exe"; DestDir: "{app}"; DestName: "whooptido-asr-captions.exe"; Flags: ignoreversion

[Registry]
; Register the native messaging host with Chrome
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.whooptido.companion"; ValueType: string; ValueName: ""; ValueData: "{app}\com.whooptido.companion.json"; Flags: uninsdeletekey

[UninstallDelete]
Type: files; Name: "{app}\com.whooptido.companion.json"

[Messages]
WelcomeLabel1=Whooptido ASR Captions
WelcomeLabel2=This will install the Whooptido ASR Captions companion app on your computer.%n%nThis companion app enables word-for-word speech recognition captions in the Whooptido browser extension.%n%nAfter installation, restart Chrome and enable Word-for-Word Captions in the Whooptido extension settings.

[Code]
// Create the native messaging manifest JSON after install
procedure CurStepChanged(CurStep: TSetupStep);
var
  ManifestPath: string;
  BinaryPath: string;
  ManifestContent: TStringList;
begin
  if CurStep = ssPostInstall then
  begin
    ManifestPath := ExpandConstant('{app}\com.whooptido.companion.json');
    BinaryPath := ExpandConstant('{app}\whooptido-asr-captions.exe');
    
    ManifestContent := TStringList.Create;
    try
      StringChangeEx(BinaryPath, '\', '\\', True);
      ManifestContent.Add('{');
      ManifestContent.Add('  "name": "com.whooptido.companion",');
      ManifestContent.Add('  "description": "Whooptido ASR Captions Companion",');
      ManifestContent.Add('  "path": "' + BinaryPath + '",');
      ManifestContent.Add('  "type": "stdio",');
      ManifestContent.Add('  "allowed_origins": [');
      ManifestContent.Add('    "chrome-extension://iabpcgbkbkkeokigbgogggaoejnbkikn/"');
      ManifestContent.Add('  ]');
      ManifestContent.Add('}');
      ManifestContent.SaveToFile(ManifestPath);
    finally
      ManifestContent.Free;
    end;
  end;
end;
