@echo off
cd /d "%~dp0"
title Baby Monitor

set "PYTHON_COMMAND="
py -3 -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>nul && set "PYTHON_COMMAND=py -3"
if not defined PYTHON_COMMAND (
    python -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>nul && set "PYTHON_COMMAND=python"
)
if not defined PYTHON_COMMAND (
    echo Python 3.9 or newer is needed once, to run the monitor.
    echo Opening the download page. Install it, tick "Add python.exe to PATH", then double-click this file again.
    start "" "https://www.python.org/downloads/"
    pause
    exit /b 1
)

if not exist ".venv\.setup-complete" (
    echo First-time setup, this takes about a minute. Please wait...
    if exist ".venv" rmdir /s /q ".venv"
    %PYTHON_COMMAND% -m venv ".venv" || goto setup_failed
    ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || goto setup_failed
    type nul > ".venv\.setup-complete"
)

".venv\Scripts\python.exe" server.py --open-browser
echo.
echo The monitor has stopped.
pause
exit /b 0

:setup_failed
echo.
echo Setup failed. Check that this computer is connected to the internet (needed only for this first run), then try again.
if exist ".venv" rmdir /s /q ".venv"
pause
exit /b 1
