# VPA MCP adapter design

## Outcome

VPA exposes its existing automation surface as a local stdio MCP server that Codex can discover and call directly. The adapter is transport-only: VPA's HTTP API remains responsible for project lookup, narration capability truth, revision checks, idempotency, job durability, render readiness, feedback state, and artifact provenance.

## Boundaries

- The MCP process reads only `VPA_API_URL` (default `http://127.0.0.1:3000`). Provider credentials remain in the VPA process started by `start.sh`.
- The adapter never shells out to `vpa`, constructs a shell command, reads project files, or reproduces server business validation.
- A reusable automation client in `@vpa/cli` owns endpoint construction and bounded API errors for both CLI and MCP consumers.
- MCP input schemas validate transport shape. Domain validation and conflict/idempotency decisions are returned unchanged from VPA.
- Long-running project narration, production recipes, and rendering return durable job IDs immediately. Job completion is reported only from the persisted VPA job record.
- Standalone narration preserves the stable #89 synchronous artifact contract: it returns only after VPA has persisted a non-empty clip. It is not represented as a background job until VPA provides a canonical standalone job contract.
- Export mutation is not mirrored as a fake MCP job. Production recipes and project render are the supported asynchronous output operations; export remains available through VPA's canonical browser/API flow.

## Tool surface

Read-only discovery:

- `list_projects`, `get_project`, `get_project_revision`, `list_project_revisions`
- `list_narration_engines`, `list_narration_voices`, `list_narration_profiles`, `describe_narration_engine`
- `list_production_recipes`, `inspect_production_recipe`
- `list_jobs`, `get_job`, `get_render_status`, `list_feedback`

Actions:

- `execute_project_commands` requires an expected revision and caller-supplied idempotency key.
- `create_standalone_narration` requires either a profile or explicit engine and voice and returns the persisted clip record.
- `start_project_narration`, `start_project_render`, and `run_production_recipe` return the VPA job submission record; narration and render require caller-supplied idempotency keys.
- `claim_feedback`, `resolve_feedback`, and `fail_feedback` submit the existing revision-aware feedback commands through the canonical project command endpoint.

Every tool returns concise text plus `structuredContent`. Failures use `isError: true` and the same bounded `code`, `status`, and `details` produced by the automation client. Read/write/destructive/open-world annotations reflect the actual operation.

## Resources

Stable resources provide low-friction inspection without creating a parallel data store:

- `vpa://projects`
- `vpa://narration/engines`
- `vpa://narration/profiles`
- `vpa://projects/{projectId}`
- `vpa://projects/{projectId}/revision`
- `vpa://projects/{projectId}/feedback`
- `vpa://projects/{projectId}/render`
- `vpa://jobs/{jobId}`

Resource reads fetch live VPA data and serialize it as JSON. No resource embeds credentials or private environment configuration.

## Idempotency and reconnect behavior

Project command batches preserve the caller's idempotency key and expected revision. Project narration and render send the key in the `Idempotency-Key` header, allowing VPA's durable job ledger to return the existing job for a reconnect instead of repeating paid or mutating work. The MCP process itself keeps no mutation cache.

## Installation and verification

The package builds an executable `vpa-mcp` stdio server. Tests exercise an in-memory MCP client/server pair for schemas, resources, results, and errors. Completion also requires installing the built command into the local Codex MCP configuration, confirming it with `codex mcp list`, and running a fresh Codex CLI session that discovers and calls a VPA tool. This follows the official OpenAI guidance that MCP servers define explicit schemas and annotations and that Codex MCP configuration is shared across its local clients.

## Deferred dependencies

Typed media-generation operations remain dependent on #93/#94. Additional feedback UX may expand after #97, but the landed claim/resolve/fail API is included now. An asynchronous standalone narration job and asynchronous export bundle should be added to the canonical VPA API before MCP exposes them as jobs; the adapter must not invent those semantics.
