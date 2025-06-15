@echo off

echo [STARTING] Simple Chat JS...
echo Chat will be available at: http://localhost:5500
echo.

REM Install dependencies if needed
if not exist "node_modules\express" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo Failed to install dependencies!
        pause
        exit /b 1
    )
    echo Dependencies installed successfully!
    echo.
)

REM Kill any existing server on port 5500
echo Checking for existing server on port 5500...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5500') do (
    echo Found process %%a using port 5500, killing it...
    taskkill /PID %%a /F >nul 2>&1
)

REM Start the server
echo Starting server...
node backend/server.js
