# Tanzu Brand as VPA's brand source

## Decision

VPA will no longer present brand creation as a primary product workflow. The canonical `tanzu-brand` package owns Tanzu tokens, approved identity assets, bumpers, provenance, and audit behavior. VPA remains responsible only for applying a versioned brand adapter to video projects.

## Integration

- Discover the package from `TANZU_BRAND_PATH` when configured, then from the shared Codex skill installation at `~/.agents/skills/tanzu-brand`. Accept repository metadata in development and the verified install manifest in packaged releases.
- Verify the package's declared asset hashes before importing anything.
- Adapt canonical tokens into VPA's existing `design.md` shape under the reserved `vmware-tanzu` brand ID.
- Copy only manifest-approved assets required by VPA: the current logo and approved intro/outro bumpers.
- Record both the Tanzu brand version and package version in the adapter.
- Create a new immutable VPA brand version only when the source package version changes.
- Keep project pinning, render integration, default-brand behavior, and brand update notices unchanged.

## Product experience

- Remove “New Brand” entry points from the dashboard, brand page, command palette, and router.
- Describe the Brand page as a connection to the managed Tanzu Brand package.
- Treat the canonical Tanzu adapter as read-only inside VPA. Users may inspect tokens, assets, usage, and history, and may set it as the default.
- If the package is unavailable, show installation/configuration guidance instead of offering a weaker in-app replacement.
- Show the detected package state and versions in Settings beside VPA's other model and production dependencies.
- When missing, offer an explicit “Download and install” confirmation. After confirmation, use the authenticated GitHub CLI to fetch the latest stable private macOS release, verify its checksum and safe archive layout, run the package's own shared installer, verify the installed result, and synchronize it without requiring a restart.
- Keep installation asynchronous and report progress and actionable recovery text. A GitHub CLI or repository-access failure must name the prerequisite instead of collapsing into a generic setup error.

## Failure behavior

- An absent package leaves the registry unchanged and VPA continues to run.
- A discovered but malformed package, hash mismatch, or reserved-ID collision fails visibly rather than importing untrusted or ambiguous assets.
- No network request or filesystem installation starts without an explicit UI confirmation. Duplicate install requests return a conflict while the active job continues.
- Existing projects remain pinned to their applied VPA adapter version until explicitly updated.

## Scope exclusions

- VPA does not run the package's final visual audit automatically in this slice.
- Existing legacy custom-brand API endpoints remain for compatibility, but no longer have first-class UI entry points.
- Automatic installation is macOS-only in this slice. Other platforms may provide a verified package through `TANZU_BRAND_PATH`.
