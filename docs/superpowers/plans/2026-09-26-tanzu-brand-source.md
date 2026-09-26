# Tanzu Brand source integration plan

## Server adapter

- Add package discovery and manifest verification.
- Convert canonical tokens into a VPA-compatible, source-attributed `design.md`.
- Synchronize the reserved `vmware-tanzu` entry at startup and preserve immutable VPA versions.
- Cover first import, idempotent restart, source update, unavailable source, and checksum failure.

## UI pivot

- Remove the dashboard brand-builder section and every “New Brand” navigation entry.
- Redirect the legacy `/brands/new` URL to the managed Brand page.
- Reframe the Brand page around the external source and a clean missing-package state.
- Make the canonical adapter read-only while keeping inspection and project application controls.

## Guided setup

- Add a typed setup status contract and endpoints for detection, refresh, and confirmed installation.
- Add a background installer that downloads only the fixed private repository's latest stable macOS release through `gh`, verifies its checksum and archive paths, delegates installation to the package's own installer, and independently synchronizes the installed result.
- Add a Connected tools card in Settings with detected versions, progress, confirmation, and clean GitHub CLI/authentication recovery.
- Point the missing Brand page state to Settings rather than requiring users to know package paths or restart VPA.

## Verification

- Run focused source synchronization, installer, setup-route, and Settings UI tests.
- Run full server and web suites plus production web build.
- Inspect Dashboard and Brand pages in the running application after restarting through `start.sh`.
