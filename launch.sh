#!/usr/bin/env bash

# ==============================================================================
# AnyAgent Desktop Launcher
# Supports detached GUI launch, multi-window instances, automatic resource
# reclamation, zombie process auto-healing, and development debug mode.
# ==============================================================================

set -e
set -m

# Skip Node.js version constraint check & ensure Electron runs in GUI mode (not as plain Node)
export VSCODE_SKIP_NODE_VERSION_CHECK=1
unset ELECTRON_RUN_AS_NODE

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
    EXE_NAME="$APP_NAME"
    CODE_EXE="./.build/electron/$APP_NAME"
    if [ ! -f "$CODE_EXE" ] && [ -f "./.build/electron/code-oss" ]; then
        CODE_EXE="./.build/electron/code-oss"
    fi
fi

# Ensure executable permissions on macOS app bundle
if [[ "$OSTYPE" == "darwin"* ]] && [ -f "$CODE_EXE" ]; then
    chmod +x "$CODE_EXE" 2>/dev/null || true
fi

PID_DIR="$HOME/.anyagent"
PID_FILE="$PID_DIR/anyagent.pid"
LOG_FILE="$PID_DIR/desktop.log"
mkdir -p "$PID_DIR"

# ------------------------------------------------------------------------------
# Process Management & Identification
# ------------------------------------------------------------------------------

# Get PIDs of only the true Main Process (exclude Helper and crashpad processes)
function get_main_pids() {
    local pids=""
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # 1. Exact executable process name match (matches 'Any Agent', NOT 'Any Agent Helper*')
        pids=$(pgrep -x "$EXE_NAME" 2>/dev/null || pgrep -x "$APP_NAME" 2>/dev/null || true)

        # 2. If not found by name, check if PID_FILE points to a live main process
        if [ -z "$pids" ] && [ -f "$PID_FILE" ]; then
            local file_pid
            file_pid=$(cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
            if [ -n "$file_pid" ] && kill -0 "$file_pid" 2>/dev/null; then
                local cmd
                cmd=$(ps -p "$file_pid" -o command= 2>/dev/null || true)
                if [[ "$cmd" == *"Contents/MacOS/${EXE_NAME}"* ]] && [[ "$cmd" != *"Helper"* ]]; then
                    pids="$file_pid"
                fi
            fi
        fi
    else
        pids=$(pgrep -x "$APP_NAME" 2>/dev/null || pgrep -f "out/main.js" 2>/dev/null || true)
    fi
    echo "$pids"
}

# Returns 0 if main process is alive, 1 otherwise
function is_main_running() {
    local main_pids
    main_pids=$(get_main_pids)
    if [ -n "$main_pids" ]; then
        return 0
    else
        return 1
    fi
}

# Get PIDs of helper or background processes associated with AnyAgent
function get_helper_pids() {
    local all_pids=""
    if [[ "$OSTYPE" == "darwin"* ]]; then
        all_pids=$(pgrep -f "Any Agent" 2>/dev/null || true)
    else
        all_pids=$(pgrep -f "($APP_NAME|code-oss|out/main.js)" 2>/dev/null || true)
    fi
    local main_pids
    main_pids=$(get_main_pids)

    local helper_pids=""
    for p in $all_pids; do
        local is_main=0
        for m in $main_pids; do
            if [ "$p" -eq "$m" ] 2>/dev/null; then
                is_main=1
                break
            fi
        done
        if [ "$is_main" -eq 0 ]; then
            helper_pids="$helper_pids $p"
        fi
    done
    echo "$helper_pids"
}

# Clean up zombie or orphan helper processes if no main process is active
function cleanup_orphans() {
    local main_pids
    main_pids=$(get_main_pids)
    if [ -z "$main_pids" ]; then
        local orphan_pids
        orphan_pids=$(get_helper_pids)
        if [ -n "$orphan_pids" ]; then
            echo "🧹 Detected orphaned background/helper processes without active main process. Cleaning up..."
            kill -9 $orphan_pids 2>/dev/null || true
            rm -f "$PID_FILE"
            sleep 0.5
        fi
    fi
}

# Bring application window to front without requiring accessibility permissions
function activate_window() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if [ -d "$APP_BUNDLE" ]; then
            open -a "$APP_BUNDLE" 2>/dev/null || true
        fi
        osascript -e "tell application \"$APP_NAME\" to activate" 2>/dev/null || true
    fi
}

# ------------------------------------------------------------------------------
# Build Verification & Self-Healing
# ------------------------------------------------------------------------------

function build_client() {
    echo "🔨 Compiling AnyAgent Desktop client (fast transpile)..."
    export VSCODE_SKIP_NODE_VERSION_CHECK=1
    npm run transpile-client
    echo "✅ Build completed successfully."
}

function check_build_integrity() {
    local needs_build=0

    # 1. Directory presence
    if [ ! -d "./out" ]; then
        echo "⚠️  Build directory './out' missing."
        needs_build=1
    fi

    # 2. Critical entrypoints check
    if [ $needs_build -eq 0 ]; then
        local critical_files=(
            "./out/main.js"
            "./out/vs/base/parts/ipc/common/ipc.js"
            "./out/vs/code/electron-main/main.js"
            "./out/vs/workbench/workbench.desktop.main.js"
            "./out/vs/platform/update/common/update.config.contribution.js"
        )
        for cf in "${critical_files[@]}"; do
            if [ ! -f "$cf" ]; then
                echo "⚠️  Critical build file missing: $cf"
                needs_build=1
                break
            fi
        done
    fi

    # 3. File count check (complete build contains > 7,000 JS files)
    if [ $needs_build -eq 0 ]; then
        local js_count
        js_count=$(find ./out -type f -name "*.js" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$js_count" -lt 5000 ]; then
            echo "⚠️  Build artifacts incomplete ($js_count JS files found, expected > 5000)."
            needs_build=1
        fi
    fi

    # 4. Source modification timestamp check
    if [ $needs_build -eq 0 ] && [ -f "./out/main.js" ]; then
        local newer_file
        newer_file=$(find ./src -type f -name "*.ts" -newer ./out/main.js 2>/dev/null | head -n 1)
        if [ -n "$newer_file" ]; then
            echo "⚡ Source files modified since last build (e.g. $newer_file). Auto-transpiling..."
            needs_build=1
        fi
    fi

    if [ $needs_build -eq 1 ]; then
        build_client
    fi
}

# Make the dev bundle start AnyAgent when opened from the Dock / Finder / Spotlight (no launch.sh involved):
#  - Contents/Resources/app -> desktop source dir: Electron loads an app found there instead of its default app
#  - LSEnvironment: the same dev environment launch.sh exports (VSCODE_DEV keeps the code-oss-dev data folder)
# Idempotent; re-applied on every launch so it survives an Electron re-download.
function setup_dock_launch() {
    local res="$APP_BUNDLE/Contents/Resources"
    local plist="$APP_BUNDLE/Contents/Info.plist"
    if [ ! -L "$res/app" ] || [ "$(readlink "$res/app")" != "$DESKTOP_DIR" ]; then
        rm -rf "$res/app" 2>/dev/null || true
        ln -s "$DESKTOP_DIR" "$res/app"
    fi
    local changed=0
    /usr/libexec/PlistBuddy -c "Print :LSEnvironment" "$plist" >/dev/null 2>&1 || { /usr/libexec/PlistBuddy -c "Add :LSEnvironment dict" "$plist"; changed=1; }
    local kv key val
    for kv in "MallocNanoZone=0" "NODE_ENV=development" "VSCODE_DEV=1" "ELECTRON_ENABLE_STACK_DUMPING=1"; do
        key="${kv%%=*}"; val="${kv#*=}"
        if [ "$(/usr/libexec/PlistBuddy -c "Print :LSEnvironment:$key" "$plist" 2>/dev/null)" != "$val" ]; then
            /usr/libexec/PlistBuddy -c "Delete :LSEnvironment:$key" "$plist" >/dev/null 2>&1 || true
            /usr/libexec/PlistBuddy -c "Add :LSEnvironment:$key string $val" "$plist"
            changed=1
        fi
    done
    if [ "$changed" -eq 1 ]; then
        # LaunchServices caches Info.plist; re-register so the Dock picks up the new environment
        /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_BUNDLE" >/dev/null 2>&1 || true
    fi
}

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
            setup_dock_launch
            touch "$APP_BUNDLE" 2>/dev/null || true
        fi
    fi

    if [ ! -f "$CODE_EXE" ]; then
        echo "⚙️  Running preLaunch to prepare Electron runtime..."
        node build/lib/preLaunch.ts
    fi

    # Thorough build integrity check
    check_build_integrity
}

# ------------------------------------------------------------------------------
# Commands
# ------------------------------------------------------------------------------

function show_help() {
    cat << EOF
AnyAgent Desktop Launcher

Usage:
  ./launch.sh [options] [path/workspace]

Options:
  (no args)             Launch AnyAgent Desktop in detached GUI mode (terminal returns immediately)
  <path>                Open the specified workspace/folder (opens in running instance or launches new)
  -n, --new-window      Open a new blank window
  -r, --restart         Cleanly stop AnyAgent and restart with a fresh instance
  -d, --dev             Launch in foreground development mode (runs watch compiler with live logs)
  -s, --status          Check running status and process PID of AnyAgent Desktop
  -k, --stop            Gracefully stop all running AnyAgent Desktop processes and clean state
  -b, --build           Force recompile desktop client code (npm run transpile-client)
  -h, --help            Show this help message

Lifecycle & Multi-Window:
  - Multi-window supported: Use Cmd+Shift+N inside the app, or run './launch.sh [path]' in terminal.
  - Automatic resource reclamation: Closing all windows automatically quits the application and frees memory, ports, and process locks.
EOF
}

function check_status() {
    local main_pids
    main_pids=$(get_main_pids)
    local helper_pids
    helper_pids=$(get_helper_pids)

    if [ -n "$main_pids" ]; then
        echo "🟢 AnyAgent Desktop is running (Main PID: $main_pids)."
        echo "   Main Process:"
        local main_comma
        main_comma=$(echo $main_pids | tr ' ' ',')
        ps -p "$main_comma" -o pid,stat,time,command 2>/dev/null | sed 's/^/     /' || true
        if [ -n "$helper_pids" ]; then
            echo "   Helper Processes:"
            local helper_comma
            helper_comma=$(echo $helper_pids | tr ' ' ',')
            ps -p "$helper_comma" -o pid,stat,time,command 2>/dev/null | sed 's/^/     /' || true
        fi
    elif [ -n "$helper_pids" ]; then
        echo "⚠️  Orphaned AnyAgent helper processes detected with NO active main process!"
        echo "   Lingering PIDs: $helper_pids"
        echo "   (Running './launch.sh' will automatically clean these up and start cleanly.)"
    else
        echo "⚪ AnyAgent Desktop is not running."
    fi
}

function stop_app() {
    local main_pids
    main_pids=$(get_main_pids)
    local all_pids=""
    if [[ "$OSTYPE" == "darwin"* ]]; then
        all_pids=$(pgrep -f "Any Agent" 2>/dev/null || true)
    else
        all_pids=$(pgrep -f "($APP_NAME|code-oss|out/main.js)" 2>/dev/null || true)
    fi

    if [ -z "$main_pids" ] && [ -z "$all_pids" ]; then
        echo "⚪ No running AnyAgent Desktop process detected."
        rm -f "$PID_FILE"
        return 0
    fi

    echo "🛑 Stopping AnyAgent Desktop..."
    if [ -n "$main_pids" ]; then
        kill $main_pids 2>/dev/null || true
    fi
    if [ -n "$all_pids" ]; then
        kill $all_pids 2>/dev/null || true
    fi

    sleep 1

    local remaining=""
    if [[ "$OSTYPE" == "darwin"* ]]; then
        remaining=$(pgrep -f "Any Agent" 2>/dev/null || true)
    else
        remaining=$(pgrep -f "($APP_NAME|code-oss|out/main.js)" 2>/dev/null || true)
    fi

    if [ -n "$remaining" ]; then
        echo "⚠️  Force terminating remaining processes ($remaining)..."
        kill -9 $remaining 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "✅ AnyAgent Desktop has stopped and all resources have been released."
}

# ------------------------------------------------------------------------------
# Argument Parsing
# ------------------------------------------------------------------------------

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
        -r|--restart)
            stop_app
            sleep 0.5
            shift
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

DISABLE_TEST_EXTENSION="--disable-extension=vscode.vscode-api-tests --js-flags=--max-old-space-size=8192"

# ------------------------------------------------------------------------------
# Execution Branches
# ------------------------------------------------------------------------------

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
        stop_app
        exit 0
    }
    trap cleanup SIGINT SIGTERM EXIT

    env -u ELECTRON_RUN_AS_NODE "$CODE_EXE" "$DESKTOP_DIR" "${TARGET_ARGS[@]}" $DISABLE_TEST_EXTENSION
else
    # 1. Check if an active main instance is already running
    if is_main_running; then
        MAIN_PID=$(get_main_pids)
        echo "ℹ️  AnyAgent Desktop is already running (PID: $MAIN_PID). Activating window..."
        if [ ${#TARGET_ARGS[@]} -eq 0 ]; then
            env -u ELECTRON_RUN_AS_NODE "$CODE_EXE" "$DESKTOP_DIR" --new-window $DISABLE_TEST_EXTENSION >/dev/null 2>&1 &
        else
            env -u ELECTRON_RUN_AS_NODE "$CODE_EXE" "$DESKTOP_DIR" "${TARGET_ARGS[@]}" $DISABLE_TEST_EXTENSION >/dev/null 2>&1 &
        fi
        sleep 0.5
        activate_window
        echo "✅ Request sent to running instance, window activated."
        exit 0
    fi

    # 2. No main process is running. Automatically clean up any orphan helpers/zombies.
    cleanup_orphans

    echo "🚀 Starting AnyAgent Desktop..."

    # Cold start without arguments: do NOT pass --new-window, so the last session (window, layout and open tabs)
    # is restored according to `window.restoreWindows`. Use -n / --new-window to force a blank window instead.
    LOCAL_ARGS=()
    if [ ${#TARGET_ARGS[@]} -gt 0 ]; then
        LOCAL_ARGS=("${TARGET_ARGS[@]}")
    fi

    # Launch detached Electron process
    nohup env -u ELECTRON_RUN_AS_NODE "$CODE_EXE" "$DESKTOP_DIR" "${LOCAL_ARGS[@]}" $DISABLE_TEST_EXTENSION > "$LOG_FILE" 2>&1 &
    APP_PID=$!
    disown $APP_PID 2>/dev/null || true

    echo "$APP_PID" > "$PID_FILE"

    # Startup health check: ensure process did not crash immediately
    sleep 2.5
    if ! kill -0 "$APP_PID" 2>/dev/null; then
        echo "❌ Error: AnyAgent Desktop failed to start (Process PID $APP_PID exited immediately)."
        if [ -f "$LOG_FILE" ]; then
            echo "📄 Recent error log output:"
            tail -n 25 "$LOG_FILE"
        fi
        rm -f "$PID_FILE"
        cleanup_orphans
        exit 1
    fi

    activate_window

    echo "✨ AnyAgent Desktop launched successfully!"
    echo "   - PID: $APP_PID"
    echo "   - Log: $LOG_FILE"
    echo "   - Terminal session detached. You may safely close this terminal window."
    echo "   - Note: Use Cmd+Shift+N for new windows. Closing the last window will quit and reclaim all resources."
fi
