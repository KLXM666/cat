@echo off
rem ---------------------------------------------------------------
rem Start a local static server for this project and open a browser.
rem Do NOT open index.html by double-clicking it: browsers block ES
rem modules under file:// and the page will look blank.
rem This script is ASCII-only on purpose (cmd.exe reads GBK).
rem ---------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "PORT=8080"
set "NODE_EXE="

where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
  echo.
  echo Node.js was not found.
  echo Install Node.js 18+ from https://nodejs.org/ and run this script again.
  echo Alternatively serve this folder with any static server, for example:
  echo     python -m http.server %PORT%
  echo then open http://127.0.0.1:%PORT%/
  echo.
  pause
  exit /b 1
)

echo Starting server on http://127.0.0.1:%PORT%/ ...
"%NODE_EXE%" "%HERE%scripts\serve.mjs" --port %PORT% --open
echo.
echo Server stopped.
pause
