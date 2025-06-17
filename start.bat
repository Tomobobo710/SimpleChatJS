@echo off

echo [STARTING] Simple Chat JS...
echo Chat will be available at: http://localhost:50505
echo Browser will open automatically.
echo.

REM Install dependencies if needed
if not exist "node_modules\express" if not exist "node_modules\open" if not exist "node_modules\better-sqlite3" (
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

REM Kill any existing server on port 50505
echo Checking for existing server on port 50505...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :50505') do (
    echo Found process %%a using port 50505, killing it...
    taskkill /PID %%a /F >nul 2>&1
)

REM Start the server
echo Starting server...
node backend/server.js
