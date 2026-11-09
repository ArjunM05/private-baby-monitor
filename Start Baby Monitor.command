#!/bin/bash
# Double-click this file to start the baby monitor (macOS). On Linux, run it from a terminal.
cd "$(dirname "$0")" || exit 1

wait_for_enter() {
    echo
    read -r -p "Press Enter to close this window..."
}

if ! command -v python3 >/dev/null 2>&1 \
    || ! python3 -c "import sys; sys.exit(sys.version_info < (3, 9))" 2>/dev/null; then
    echo "Python 3.9 or newer is needed once, to run the monitor."
    echo "Install it from https://www.python.org/downloads/ and then open this file again."
    wait_for_enter
    exit 1
fi

if [ ! -f ".venv/.setup-complete" ]; then
    echo "First-time setup, this takes about a minute. Please wait..."
    rm -rf ".venv"
    if ! python3 -m venv ".venv" || ! .venv/bin/python -m pip install --quiet -r requirements.txt; then
        echo
        echo "Setup failed. Check that this computer is connected to the internet (needed only for this first run), then try again."
        rm -rf ".venv"
        wait_for_enter
        exit 1
    fi
    touch ".venv/.setup-complete"
fi

.venv/bin/python server.py --open-browser
echo
echo "The monitor has stopped."
wait_for_enter
