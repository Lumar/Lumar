@echo off
cd /d "%~dp0"
py -3 server.py --set-password
if errorlevel 1 python server.py --set-password
pause
