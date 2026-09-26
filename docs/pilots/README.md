# Production pilot evidence

`production-pilot.json` is the completed deterministic qualification baseline for issue #100. The five cases run through the same production recipe and revision contracts exposed to Codex. The automated pilot creates real MP4 source media, produces a draft, applies and resolves visual feedback, restores the prior source-backed revision, copies a playable export, and verifies it with `ffprobe`.

The recorded zero hands-on time means the qualification is automated. The omissions deliberately identify subjective checks—pacing, narration naturalness, camera framing, and redaction aesthetics—that remain appropriate for human review rather than presenting synthetic media as a usability study.

Run the qualification with:

```bash
npm test --workspace @vpa/server -- production-pilot.test.ts
```
