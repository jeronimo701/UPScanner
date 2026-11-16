#ifndef Payload
#error Payload is required
#endif
#ifndef SetupOut
#error SetupOut is required
#endif
[Setup]
AppId=Jeronimo701-UPScanner
AppName=UPScanner
AppVersion=2026.11.16
AppPublisher=Jeronimo701
DefaultDirName={localappdata}\Programs\UPScanner
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
Uninstallable=no
CreateUninstallRegKey=no
OutputDir={#SetupOut}
OutputBaseFilename=UPScanner-Setup-2026-11-16
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"
[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
