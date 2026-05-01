#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# VPA Python venv setup
#
# Creates a .venv at the project root and installs Python
# dependencies needed by local TTS providers (Fish Audio).
#
# Safe to re-run — skips work already done.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$PROJECT_ROOT/.venv"

echo "── VPA Python setup ──────────────────────────"

# 1. Check for python3
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Install Python 3 first."
  exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1)
echo "Using: $PYTHON_VERSION ($(which python3))"

# 2. Create venv if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtual environment at .venv ..."
  python3 -m venv "$VENV_DIR"
  echo "  Done."
else
  echo "Virtual environment already exists at .venv"
fi

# 3. Activate and install dependencies
source "$VENV_DIR/bin/activate"

echo "Installing Python dependencies..."
pip install --upgrade pip --quiet
pip install mlx-audio --quiet 2>&1 | tail -1 || {
  echo ""
  echo "NOTE: mlx-audio requires Apple Silicon (M1+) and macOS."
  echo "If you're on a different platform, Fish Audio TTS won't be available."
}

echo ""
echo "── Installed packages ──────────────────────────"
pip list 2>/dev/null | grep -i -E "mlx|audio" || echo "(none matching mlx/audio)"

echo ""
echo "── Done! ─────────────────────────────────────────"
echo "VPA will automatically use .venv/bin/python3 for Fish Audio TTS."
echo ""
