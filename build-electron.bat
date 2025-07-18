@echo off
setlocal enabledelayedexpansion

echo Building SimpleChatJS Electron App (Clean Pipeline)...
echo ====================================
echo.

REM Ensure we're in the right directory
if not exist "package.json" (
    echo Error: package.json not found. Run this script from the SimpleChatJS root directory.
    pause
    exit /b 1
)

REM Install main app dependencies first
echo [1/4] Installing main app dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo Failed to install main dependencies
    pause
    exit /b 1
)

REM Backup original package.json and use build version
echo [2/4] Switching to build configuration...
copy "package.json" "package.json.backup" >nul
if not exist "package-build.json" (
    echo Error: package-build.json not found. This file is required for building.
    del "package.json.backup" >nul 2>&1
    pause
    exit /b 1
)
copy "package-build.json" "package.json" >nul

REM Install build dependencies
echo [3/4] Installing build dependencies and building...
call npm install electron@^28.0.0 electron-builder@^24.9.1 --save-dev --no-audit --no-fund
if errorlevel 1 (
    echo Failed to install build dependencies
    move "package.json.backup" "package.json" >nul
    pause
    exit /b 1
)

REM Build the app
if exist "dist-electron" rmdir /s /q "dist-electron" >nul 2>&1
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm run build
if errorlevel 1 (
    echo Build failed
    move "package.json.backup" "package.json" >nul
    pause
    exit /b 1
)

REM Restore original package.json and clean install
echo [4/4] Restoring clean development environment...
move "package.json.backup" "package.json" >nul
if exist "node_modules" rmdir /s /q "node_modules" >nul 2>&1
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo Warning: Failed to restore clean dependencies, but build completed
)

echo.
echo ====================================
echo BUILD COMPLETE!
echo ====================================
echo.
echo Electron app: dist-electron\win-unpacked\SimpleChatJS.exe
echo.
echo ✓ Build completed successfully
echo ✓ Development environment restored (no Electron deps)
echo ✓ npm start and start.bat will work normally
echo ✓ package-build.json preserved
echo.
pause
