@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
node scripts\build.cjs
if errorlevel 1 (
  echo Appen kunne ikke bygges.
  pause
  exit /b 1
)
set "FJORDFLIX_SIM=%LOCALAPPDATA%\FjordFlix-TV-Simulator\webOS_TV_6.0_Simulator_1.4.1\webOS_TV_6.0_Simulator_1.4.1.exe"
if not exist "%FJORDFLIX_SIM%" (
  echo webOS simulatoren blev ikke fundet.
  pause
  exit /b 1
)
start "" "%FJORDFLIX_SIM%" "%~dp0dist\app"
