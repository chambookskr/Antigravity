@echo off
setlocal
set "APP_DIR=%~dp0"
set "NODE_EXE=C:\Users\mj\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
set "NODE_PATH=C:\Users\mj\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules;C:\Users\mj\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\.pnpm\node_modules"
set "PORT="
set "APP_URL="
set "CHROME_EXE="

if not exist "%NODE_EXE%" (
  echo Node.js runtime was not found:
  echo %NODE_EXE%
  pause
  exit /b 1
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"

for /f %%U in ('powershell -NoProfile -Command "for ($p=4177; $p -le 4197; $p++) { try { $r=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$p+'/api/status') -TimeoutSec 1; if ($r.app -eq 'naver-place-keyword-extractor') { 'http://127.0.0.1:'+$p; break } } catch {} }"') do set "APP_URL=%%U"

if not defined APP_URL (
  for /f %%P in ('powershell -NoProfile -Command "for ($p=4177; $p -le 4197; $p++) { try { $l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse('127.0.0.1'),$p); $l.Start(); $l.Stop(); Write-Output $p; break } catch {} }"') do set "PORT=%%P"
  
  rem Use call set to bypass batch variable expansion limitations inside if block
  call set "TEMP_PORT=%%PORT%%"
  if not defined TEMP_PORT set "PORT=4177"
  
  start "Naver Place Keyword Server" /min "%NODE_EXE%" "%APP_DIR%server.js"
  timeout /t 2 /nobreak >nul
  
  call set "APP_URL=http://127.0.0.1:%%PORT%%"
)


if defined CHROME_EXE (
  start "" "%CHROME_EXE%" "%APP_URL%"
) else (
  start "" "%APP_URL%"
)
endlocal
