@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo Typero 使用本机后台服务提供双击打开与原地保存。
echo 停止服务后，已经打开的 Typero 窗口将无法继续保存文件。
echo.
choice /c YN /n /m "确定停止 Typero 本地服务吗？[Y/N] "
if errorlevel 2 goto cancelled

echo.
echo 正在停止 Typero...
node scripts\launch.mjs --stop
if errorlevel 1 (
  echo.
  echo 停止失败，请查看 .typero\launcher.log
  echo.
  pause
  exit /b 1
)

echo.
timeout /t 2 >nul
goto end

:cancelled
echo.
echo 已取消。

:end
endlocal
