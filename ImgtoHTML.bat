@echo off
rem Double-click to start ImgtoHTML (vision model, app server, browser) in WSL.
rem Close this window or press Ctrl+C to stop it.
title ImgtoHTML
wsl.exe -d ubuntu -- bash -lc "bash \"$(wslpath '%~dp0')/web/start.sh\""
pause
