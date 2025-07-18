#!/bin/bash

echo "Building SimpleChatJS Electron App (Clean Pipeline)..."
echo "===================================="
echo ""

# Ensure we're in the right directory
if [ ! -f "package.json" ]; then
    echo "Error: package.json not found. Run this script from the SimpleChatJS root directory."
    exit 1
fi

# Install main app dependencies first
echo "[1/4] Installing main app dependencies..."
npm install --no-audit --no-fund
if [ $? -ne 0 ]; then
    echo "Failed to install main dependencies"
    exit 1
fi

# Backup original package.json and use build version
echo "[2/4] Switching to build configuration..."
cp "package.json" "package.json.backup"
if [ ! -f "package-build.json" ]; then
    echo "Error: package-build.json not found. This file is required for building."
    rm -f "package.json.backup"
    exit 1
fi
cp "package-build.json" "package.json"

# Install build dependencies
echo "[3/4] Installing build dependencies and building..."
npm install electron@^28.0.0 electron-builder@^24.9.1 --save-dev --no-audit --no-fund
if [ $? -ne 0 ]; then
    echo "Failed to install build dependencies"
    mv "package.json.backup" "package.json"
    exit 1
fi

# Build the app
rm -rf "dist-electron" 2>/dev/null
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run build
if [ $? -ne 0 ]; then
    echo "Build failed"
    mv "package.json.backup" "package.json"
    exit 1
fi

# Restore original package.json and clean install
echo "[4/4] Restoring clean development environment..."
mv "package.json.backup" "package.json"
rm -rf "node_modules" 2>/dev/null
npm install --no-audit --no-fund
if [ $? -ne 0 ]; then
    echo "Warning: Failed to restore clean dependencies, but build completed"
fi

echo ""
echo "===================================="
echo "BUILD COMPLETE!"
echo "===================================="
echo ""
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Electron app: dist-electron/mac/SimpleChatJS.app"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "Electron app: dist-electron/linux-unpacked/SimpleChatJS"
else
    echo "Electron app: check dist-electron/ directory"
fi
echo ""
echo "✓ Build completed successfully"
echo "✓ Development environment restored (no Electron deps)"
echo "✓ npm start will work normally"
echo "✓ package-build.json preserved"
echo ""
