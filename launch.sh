#!/usr/bin/env bash

# ==============================================================================
# AnyAgent Desktop Launcher
# Supports detached GUI launch, multi-window instances, automatic resource
# reclamation, and development debug mode.
# ==============================================================================

set -e

# Skip Node.js version constraint check
export VSCODE_SKIP_NODE_VERSION_CHECK=1

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$SCRIPT_DIR/desktop" ]; then
    ROOT_DIR="$SCRIPT_DIR"
    DESKTOP_DIR="$SCRIPT_DIR/desktop"
elif [ -f "$SCRIPT_DIR/product.json" ]; then
    ROOT_DIR="$(dirname "$SCRIPT_DIR")"
    DESKTOP_DIR="$SCRIPT_DIR"
else
    echo "❌ Error: Failed to locate AnyAgent desktop root directory."
    exit 1
fi

cd "$DESKTOP_DIR"

# Application metadata resolution
if [[ "$OSTYPE" == "darwin"* ]]; then
    APP_NAME=$(node -p "require('./product.json').nameLong" 2>/dev/null || echo "Any Agent")
    EXE_NAME=$(node -p "require('./product.json').nameShort" 2>/dev/null || echo "Any Agent")
    APP_BUNDLE="./.build/electron/$APP_NAME.app"
    CODE_EXE="$APP_BUNDLE/Contents/MacOS/$EXE_NAME"
else
    APP_NAME=$(node -p "require('./product.json').applicationName" 2>/dev/null || echo "anyagent")
    CODE_EXE="./.build/electron/$APP_NAME"
    if [ ! -f "$CODE_EXE" ] && [ -f "./.build/electron/code-oss" ]; then
        CODE_EXE="./.build/electron/code-oss"
    fi
fi

PID_DIR="$HOME/.anyagent"
PID_FILE="$PID_DIR/anyagent.pid"
mkdir -p "$PID_DIR"

# Help manual
function show_help() {
    cat << EOF
AnyAgent Desktop Launcher

Usage:
  ./launch.sh [options] [path/workspace]

Options:
  (no args)             Launch AnyAgent Desktop in detached GUI mode (terminal returns immediately)
  <path>                Open the specified workspace/folder (opens a new window if already running)
  -n, --new-window      Open a new blank window
  -d, --dev             Launch in foreground development mode (runs watch compiler with live logs)
  -s, --status          Check running status and process PID of AnyAgent Desktop
  -k, --stop            Gracefully stop all running AnyAgent Desktop processes
  -b, --build           Recompile desktop client code (npm run compile-client)
  -h, --help            Show this help message

Lifecycle & Multi-Window:
  - Multi-window supported: Use Cmd+Shift+N (or Ctrl+Shift+N) inside the app, or run './launch.sh [path]' in terminal.
  - Automatic resource reclamation: Closing the last window automatically quits the application and frees memory, ports, and process locks.
EOF
}

# Check if application is running
function is_running() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        pgrep -x "$EXE_NAME" >/dev/null 2>&1 || pgrep -f "Any Agent.app/Contents/MacOS" >/dev/null 2>&1
    else
        pgrep -x "$APP_NAME" >/dev/null 2>&1 || pgrep -f "out/main.js" >/dev/null 2>&1
    fi
}

# Check status
function check_status() {
    if is_running; then
        echo "🟢 AnyAgent Desktop is running."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            ps aux | grep -E "(Any Agent.app|$EXE_NAME)" | grep -v grep | awk '{printf "   PID: %-7s CPU: %-5s MEM: %-5s COMMAND: %s\n", $2, $3, $4, $11}'
        else
            ps aux | grep -E "($APP_NAME|out/main.js)" | grep -v grep | awk '{printf "   PID: %-7s CPU: %-5s MEM: %-5s COMMAND: %s\n", $2, $3, $4, $11}'
        fi
    else
        echo "⚪ AnyAgent Desktop is not running."
    fi
}

# Stop application
function stop_app() {
    if ! is_running; then
        echo "⚪ No running AnyAgent Desktop process detected."
        rm -f "$PID_FILE"
        return 0
    fi

    echo "🛑 Stopping AnyAgent Desktop..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        pkill -x "$EXE_NAME" 2>/dev/null || true
        pkill -f "Any Agent.app/Contents/MacOS" 2>/dev/null || true
    else
        pkill -x "$APP_NAME" 2>/dev/null || true
        pkill -f "out/main.js" 2>/dev/null || true
    fi

    sleep 1
    if is_running; then
        echo "⚠️  Force terminating remaining processes..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            pkill -9 -x "$EXE_NAME" 2>/dev/null || true
            pkill -9 -f "Any Agent.app/Contents/MacOS" 2>/dev/null || true
        else
            pkill -9 -x "$APP_NAME" 2>/dev/null || true
            pkill -9 -f "out/main.js" 2>/dev/null || true
        fi
    fi
    rm -f "$PID_FILE"
    echo "✅ AnyAgent Desktop has stopped and all resources have been released."
}

# Compile client code
function build_client() {
    echo "🔨 Compiling AnyAgent Desktop client..."
    export VSCODE_SKIP_NODE_VERSION_CHECK=1
    npm run compile-client
    echo "✅ Build completed successfully."
}

# Ensure binary and runtime ready
function ensure_binary() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if [ ! -f "$CODE_EXE" ] && [ -d "./.build/electron/Code - OSS.app" ]; then
            echo "📦 Initializing AnyAgent.app bundle..."
            cp -a "./.build/electron/Code - OSS.app" "$APP_BUNDLE"
            if [ -f "$APP_BUNDLE/Contents/MacOS/Code - OSS" ]; then
                mv "$APP_BUNDLE/Contents/MacOS/Code - OSS" "$CODE_EXE"
            fi
            plutil -replace CFBundleName -string "$APP_NAME" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
            plutil -replace CFBundleDisplayName -string "$APP_NAME" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
            plutil -replace CFBundleExecutable -string "$EXE_NAME" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
            for type in "" " (GPU)" " (Plugin)" " (Renderer)"; do
                src="$APP_BUNDLE/Contents/Frameworks/Code - OSS Helper${type}.app"
                dst="$APP_BUNDLE/Contents/Frameworks/${EXE_NAME} Helper${type}.app"
                exe_src="Code - OSS Helper${type}"
                exe_dst="${EXE_NAME} Helper${type}"
                if [ -d "$src" ] && [ ! -d "$dst" ]; then
                    cp -a "$src" "$dst"
                    if [ -f "$dst/Contents/MacOS/$exe_src" ]; then
                        mv "$dst/Contents/MacOS/$exe_src" "$dst/Contents/MacOS/$exe_dst"
                    fi
                    plutil -replace CFBundleName -string "$exe_dst" "$dst/Contents/Info.plist" 2>/dev/null || true
                    plutil -replace CFBundleExecutable -string "$exe_dst" "$dst/Contents/Info.plist" 2>/dev/null || true
                fi
            done
        fi

        if [ -d "$APP_BUNDLE" ]; then
            if [ -f "./resources/darwin/code.icns" ]; then
                cp -f "./resources/darwin/code.icns" "$APP_BUNDLE/Contents/Resources/Any Agent.icns" 2>/dev/null || true
                cp -f "./resources/darwin/code.icns" "$APP_BUNDLE/Contents/Resources/Code - OSS.icns" 2>/dev/null || true
            fi
            plutil -replace CFBundleIdentifier -string "com.anyagent.desktop" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
            plutil -replace CFBundleIconFile -string "Any Agent.icns" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
            plutil -replace CFBundleName -string "$APP_NAME" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
            plutil -replace CFBundleDisplayName -string "$APP_NAME" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
            touch "$APP_BUNDLE" 2>/dev/null || true
        fi
    fi

    if [ ! -f "$CODE_EXE" ]; then
        echo "⚙️  Running preLaunch to prepare Electron runtime..."
        node build/lib/preLaunch.ts
    fi

    if [ ! -d "./out" ] || [ ! -f "./out/main.js" ]; then
        echo "⚠️  Core build artifacts not found, compiling..."
        build_client
    fi
}

# Parse arguments
MODE="normal"
TARGET_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            show_help
            exit 0
            ;;
        -s|--status)
            check_status
            exit 0
            ;;
        -k|--stop)
            stop_app
            exit 0
            ;;
        -b|--build)
            build_client
            exit 0
            ;;
        -d|--dev)
            MODE="dev"
            shift
            ;;
        -n|--new-window)
            TARGET_ARGS+=("--new-window")
            shift
            ;;
        *)
            TARGET_ARGS+=("$1")
            shift
            ;;
    esac
done

ensure_binary

# Environment configuration
export NODE_ENV=development
export VSCODE_DEV=1
export VSCODE_CLI=1
export ELECTRON_ENABLE_STACK_DUMPING=1
export ELECTRON_ENABLE_LOGGING=1

DISABLE_TEST_EXTENSION="--disable-extension=vscode.vscode-api-tests"

# Execution branches
if [ "$MODE" == "dev" ]; then
    echo "🚀 Starting AnyAgent Desktop (Development Mode)..."
    echo "💡 Note: Watch compiler running in background, live logs shown below. Press Ctrl+C to exit."
    
    # Start background transpile watcher
    npm run watch-client-transpile > /dev/null 2>&1 &
    WATCH_PID=$!

    cleanup() {
        echo ""
        echo "🛑 Stopping development environment..."
        kill $WATCH_PID 2>/dev/null || true
        exit 0
    }
    trap cleanup SIGINT SIGTERM EXIT

    "$CODE_EXE" . "${TARGET_ARGS[@]}" $DISABLE_TEST_EXTENSION
else
    # Detached GUI Mode (Normal application lifecycle)
    if is_running; then
        echo "ℹ️  AnyAgent Desktop is already running. Opening new window..."
        if [ ${#TARGET_ARGS[@]} -eq 0 ]; then
            "$CODE_EXE" . --new-window $DISABLE_TEST_EXTENSION >/dev/null 2>&1 &
        else
            "$CODE_EXE" . "${TARGET_ARGS[@]}" $DISABLE_TEST_EXTENSION >/dev/null 2>&1 &
        fi
        echo "✅ Request sent to running instance, new window opened."
        exit 0
    fi

    echo "🚀 Starting AnyAgent Desktop..."

    LOG_FILE="$PID_DIR/desktop.log"

    if [[ "$OSTYPE" == "darwin"* ]]; then
        nohup "$CODE_EXE" . "${TARGET_ARGS[@]}" $DISABLE_TEST_EXTENSION > "$LOG_FILE" 2>&1 &
        APP_PID=$!
        disown $APP_PID 2>/dev/null || true
    else
        nohup "$CODE_EXE" . "${TARGET_ARGS[@]}" $DISABLE_TEST_EXTENSION > "$LOG_FILE" 2>&1 &
        APP_PID=$!
        disown $APP_PID 2>/dev/null || true
    fi

    echo "$APP_PID" > "$PID_FILE"

    echo "✨ AnyAgent Desktop launched successfully!"
    echo "   - PID: $APP_PID"
    echo "   - Log: $LOG_FILE"
    echo "   - Terminal session detached. You may safely close this terminal window."
    echo "   - Note: Use Cmd+Shift+N for new windows. Closing the last window will quit and reclaim all resources."
fi
