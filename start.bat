@echo off

echo [STARTING] Simple Chat JS...
echo Chat will be available at: http://localhost:50505
echo Browser will open automatically.
echo.

REM Check if Node.js is installed
echo Checking for Node.js installation...
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js is not installed!
    echo.
    echo Please download and install Node.js from:
    echo https://nodejs.org
    echo.
    echo After installing, restart this script.
    pause
    exit /b 1
)

echo Node.js found!
echo.

REM Install dependencies if node_modules doesn't exist or is incomplete
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo Failed to install dependencies!
        pause
        exit /b 1
    )
    echo Dependencies installed successfully!
    echo.
) else (
    echo Checking if all dependencies are installed...
    call npm ls --depth=0 >nul 2>&1
    if errorlevel 1 (
        echo Missing dependencies detected, installing...
        call npm install
        if errorlevel 1 (
            echo Failed to install dependencies!
            pause
            exit /b 1
        )
        echo Dependencies installed successfully!
        echo.
    ) else (
        echo All dependencies are present.
    )
)

REM Kill any existing server on port 50505
echo Checking for existing server on port 50505...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :50505') do (
    echo Found process %%a using port 50505, killing it...
    taskkill /PID %%a /F >nul 2>&1
)

REM Start the server
echo Starting server...
node backend/server.js
