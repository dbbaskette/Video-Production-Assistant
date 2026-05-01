.PHONY: start stop dev build test typecheck lint clean setup-python

# Start dev servers (kills any previous instances first)
start: dev

dev:
	./start.sh

# Start with a fresh build
start-build:
	./start.sh --build

# Production mode
prod:
	./start.sh --prod

# Kill any running VPA processes
stop:
	@echo "Stopping VPA processes..."
	@lsof -ti tcp:$${VPA_SERVER_PORT:-3000} 2>/dev/null | xargs kill -9 2>/dev/null || true
	@lsof -ti tcp:5173 2>/dev/null | xargs kill -9 2>/dev/null || true
	@echo "Done."

# Build everything
build:
	npm run build

# Run all tests
test:
	npm test

# TypeScript type checking
typecheck:
	npx tsc -b

# Lint
lint:
	npm run lint

# Setup Python venv for local TTS (Fish Audio)
setup-python:
	./scripts/setup-python.sh

# Clean build artifacts
clean:
	rm -rf packages/shared/dist apps/server/dist apps/web/dist
	find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
