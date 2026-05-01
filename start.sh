#!/usr/bin/env bash
set -euo pipefail

# Video Production Assistant — quick start
# Usage: ./start.sh [--build] [--prod]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Parse flags
BUILD=false
PROD=false
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=true ;;
    --prod)  PROD=true ;;
    --help|-h)
      echo "Usage: ./start.sh [--build] [--prod]"
      echo ""
      echo "Flags:"
      echo "  --build   Run npm install and build before starting"
      echo "  --prod    Start in production mode (built assets, no hot reload)"
      echo "  --help    Show this help"
      echo ""
      echo "Environment:"
      echo "  Copy .env.example to .env and edit as needed."
      echo "  Key variables: VPA_LLM_PROVIDER, GEMINI_API_KEY, ANTHROPIC_API_KEY"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg (try --help)"
      exit 1
      ;;
  esac
done

# Load .env if present
if [ -f .env ]; then
  echo "Loading .env..."
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

# Check prerequisites
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "Error: $1 is required but not found. Please install it first."
    exit 1
  fi
}

check_cmd node
check_cmd npm

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "Error: Node.js 20+ is required (found v$(node -v))"
  exit 1
fi

# Optional: check for ffmpeg/ffprobe (needed for recording features)
if ! command -v ffprobe &>/dev/null; then
  echo "Warning: ffprobe not found. Video metadata extraction will not work."
  echo "         Install ffmpeg to enable recording features."
fi
if ! command -v ffmpeg &>/dev/null; then
  echo "Warning: ffmpeg not found. Overlay rendering and recording splitting will not work."
  echo "         Install ffmpeg to enable video processing features."
fi

# Build if requested or if node_modules missing
if [ "$BUILD" = true ] || [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
  echo "Building shared package..."
  npm run build -w @vpa/shared
fi

if [ "$PROD" = true ]; then
  echo "Building for production..."
  npm run build

  echo ""
  echo "Starting VPA in production mode..."
  echo "  Server: http://${VPA_SERVER_HOST:-127.0.0.1}:${VPA_SERVER_PORT:-3000}"
  echo "  LLM:    ${VPA_LLM_PROVIDER:-fake}"
  echo ""

  cd apps/server
  node dist/server.js
else
  echo ""
  echo "Starting VPA in development mode..."
  echo "  Server: http://${VPA_SERVER_HOST:-127.0.0.1}:${VPA_SERVER_PORT:-3000}"
  echo "  Web:    http://localhost:5173"
  echo "  LLM:    ${VPA_LLM_PROVIDER:-fake}"
  echo ""

  npm run dev
fi
