@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未找到 Node.js，请先安装 Node.js 18 或更高版本。
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\marked" (
  echo.
  echo 正在安装依赖，请稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto failed
)

echo.
echo 正在构建 Typero...
call node scripts\build.mjs
if errorlevel 1 goto failed

echo.
echo 正在启动 Typero...
node scripts\launch.mjs %*
if errorlevel 1 goto failed
goto end

:failed
echo.
echo Typero 启动失败，请查看上方的错误信息。
echo.
pause

:end
endlocal
