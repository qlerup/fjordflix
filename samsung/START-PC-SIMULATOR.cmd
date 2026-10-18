@echo off
cd /d "%~dp0"
call npm run build
if errorlevel 1 exit /b 1
start "FjordFlix Samsung preview" http://127.0.0.1:8128/
call npm run preview
