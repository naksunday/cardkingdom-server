@echo off
title CardKingdom - Internet Tunnel (ngrok)
color 0B
echo.
echo  =============================================
echo   CardKingdom - Internet Tunnel
echo   Friends can connect from anywhere!
echo  =============================================
echo.
echo  Starting ngrok tunnel on port 3000...
echo  (Make sure run.bat server is also running!)
echo.
echo  Look for the line:
echo    Forwarding   https://xxxxx.ngrok-free.app
echo  Copy that link and send to your friend.
echo  They use it as: wss://xxxxx.ngrok-free.app
echo.
echo  =============================================
echo.
npx ngrok http 3000
pause
