@echo off
REM Lance le serveur obsApiServer.js en tâche de fond puis l'app Electron packagée

REM Lance le serveur Node (Express)
start "" node "%~dp0obsApiServer.js"

REM Attend 1 seconde pour laisser le serveur démarrer
ping 127.0.0.1 -n 2 >nul

REM Lance l'app Electron packagée
start "" "%~dp0dist\win-unpacked\oneclick-hub-desktop.exe"
