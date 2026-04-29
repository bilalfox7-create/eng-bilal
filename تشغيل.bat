@echo off
title نظام إعاشات المهندسين
chcp 65001 > nul

echo.
echo  ==========================================
echo   نظام إعاشات المهندسين - ليبيا
echo  ==========================================
echo.

SET PATH=C:\Program Files\nodejs;%PATH%
cd /d "%~dp0"

echo  جارٍ تشغيل السيرفر...
echo  افتح المتصفح على: http://localhost:3000
echo  للإيقاف: اضغط Ctrl+C
echo.

"C:\Program Files\nodejs\node.exe" server.js

pause
