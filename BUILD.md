# SimpleChatJS Clean Build Pipeline

## The Problem
Electron builds require `electron` and `electron-builder` as dependencies, but these pollute your development environment and can interfere with your regular `npm start` and `start.bat` scripts.

## The Solution
This build pipeline keeps your development environment completely clean by:

1. **Installing your main app dependencies** (Express, SQLite, etc.)
2. **Temporarily switching** to a build-specific `package.json` 
3. **Building the Electron app** with isolated build dependencies
4. **Restoring your clean development environment** automatically

## Files

- `package.json` - Your clean development dependencies (no Electron)
- `package-build.json` - Build configuration with Electron dependencies  
- `build-electron.bat` - Windows build script
- `build-electron.sh` - Linux/Mac build script
- `build-electron.ps1` - Original PowerShell script (backup)

## Usage

### Windows
```batch
build-electron.bat
```

### Linux/Mac
```bash
./build-electron.sh
```

*Note: The script will build a native app for your platform (Linux AppImage/dir or Mac .app)*

### Manual Process
```bash
# Install main dependencies
npm install

# Temporarily switch to build config
copy package-build.json package.json

# Install build deps and build
npm install electron electron-builder --save-dev
npm run build

# Restore clean environment
git checkout package.json
npm install
```

## How It Works

1. **Installs** your main app dependencies normally
2. **Backs up** your original `package.json`
3. **Copies** `package-build.json` over `package.json` (contains Electron config)
4. **Installs** Electron build dependencies
5. **Builds** the Electron app
6. **Restores** your original `package.json`
7. **Reinstalls** clean dependencies

## Benefits

✅ **Clean Dev Environment**: Your main `package.json` never gets Electron dependencies
✅ **Works in Fresh Clones**: No setup required, works immediately
✅ **Reliable Dev Scripts**: `npm start` and `start.bat` always work
✅ **Simple**: No complex directory structures or path issues
✅ **Automatic Cleanup**: Restores your environment automatically

## Output

Built app will be in: `dist-electron/win-unpacked/SimpleChatJS.exe`

## Troubleshooting

If something goes wrong:
1. The script will automatically restore your `package.json` from backup
2. Delete `node_modules` and run `npm install` to reset
3. Your development environment should be clean again
