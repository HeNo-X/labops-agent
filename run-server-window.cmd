@echo off
rem 在独立终端窗口启动 LabOps Agent 服务端（生产模式，单端口 8787）
rem %~dp0 保证无论从哪里调用都先切到本文件所在目录
cd /d "%~dp0"
title LabOps Agent · 8787
echo [LabOps] 正在启动服务端（node server/index.ts）...
echo [LabOps] 关闭本窗口或按 Ctrl+C 即可停止服务。
echo.
node server/index.ts
pause
