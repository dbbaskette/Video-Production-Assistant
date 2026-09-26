# VPA MCP adapter implementation plan

1. Extract the reusable VPA automation client surface from the CLI package, including optional request headers and typed read/action helpers.
2. Add `@vpa/mcp` with the official TypeScript MCP SDK, stdio entry point, explicit tool schemas/annotations, and live JSON resources.
3. Add narration, revision-aware command, job, render, production-recipe, and feedback mappings without local business validation or credentials.
4. Add protocol tests for discovery, narration parity, bounded failures, idempotency headers, resources, and duplicate submissions.
5. Build and run the complete relevant suites, install the built server in Codex, and verify discovery plus one real tool call from a fresh Codex process.
6. Publish the scoped PR, merge it after checks, and update #120 with deferred canonical-contract follow-ups rather than fabricating adapter-only behavior.

- [x] 1
- [x] 2
- [x] 3
- [x] 4
- [x] 5
- [ ] 6

## Verification ownership

- `@vpa/cli`: endpoint/error parity and backward compatibility.
- `@vpa/mcp`: protocol discovery, schemas, resources, structured results, annotations, and stdio startup.
- Installed Codex client: configuration visibility and real tool invocation.
- VPA server: canonical revision, idempotency, job, artifact, and provider behavior remains covered by its existing suites.
