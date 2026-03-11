#!/bin/zsh
PROJECT_ROOT="__PROJECT_ROOT__"
DEFAULT_NODE_PATH="__NODE_PATH__"
CONTROL_DIR="$PROJECT_ROOT/.ui-control"
LOG_PATH="$CONTROL_DIR/app-launcher.log"

if /usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null | grep -q "^1$"; then
  NODE_CMD=(/usr/bin/arch -arm64 "$DEFAULT_NODE_PATH")
else
  NODE_CMD=("$DEFAULT_NODE_PATH")
fi

mkdir -p "$CONTROL_DIR"
"${NODE_CMD[@]}" "$PROJECT_ROOT/scripts/ui-app-launcher.mjs" stop >>"$LOG_PATH" 2>&1
status=$?

if [ "$status" -ne 0 ]; then
  /usr/bin/osascript -e 'display dialog "Stop AgenticAGI failed. See .ui-control/app-launcher.log for details." with title "Stop AgenticAGI" buttons {"OK"} default button "OK" with icon stop'
fi

exit "$status"
