import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { assistanceApi } from '../lib/api.js';

export function AssistancePanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [targetDurationSec, setTargetDurationSec] = useState(180);
  const [requestedTarget, setRequestedTarget] = useState<number | null>(null);
  const suggestions = useQuery({
    queryKey: ['assistance', projectId, requestedTarget],
    queryFn: () => assistanceApi.inspect(projectId, requestedTarget!),
    enabled: requestedTarget !== null,
  });
  const apply = useMutation({
    mutationFn: (proposalId: string) => assistanceApi.apply(projectId, proposalId, {
      expectedRevision: suggestions.data!.revision,
      targetDurationSec: requestedTarget!,
      idempotencyKey: crypto.randomUUID(),
    }),
    onSuccess: async () => {
      await Promise.all([
        suggestions.refetch(),
        queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['revisions', projectId] }),
      ]);
    },
  });

  return (
    <section style={{ padding: 18, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 24 }} aria-labelledby="assistance-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'end', flexWrap: 'wrap' }}>
        <div><strong id="assistance-title">Editorial assistance</strong><p className="hint" style={{ marginBottom: 0 }}>Review source-cited cuts, highlight ranges, callouts, focus regions and sensitive-content flags. Nothing is applied automatically.</p></div>
        <label style={{ fontSize: 12 }}>Target duration (seconds)<div style={{ display: 'flex', gap: 8, marginTop: 4 }}><input aria-label="Target duration seconds" type="number" min={15} max={3600} value={targetDurationSec} onChange={(event) => setTargetDurationSec(Number(event.target.value))} style={{ width: 100 }} /><button onClick={() => setRequestedTarget(targetDurationSec)} disabled={suggestions.isFetching}>{suggestions.isFetching ? 'Inspecting…' : 'Build proposals'}</button></div></label>
      </div>
      {suggestions.data && <div style={{ marginTop: 12, fontSize: 12 }}><strong>{(suggestions.data.current_duration_ms / 1000).toFixed(1)}s</strong> current → <strong>{(suggestions.data.projected_duration_ms / 1000).toFixed(1)}s</strong> projected · {suggestions.data.tolerance_met ? 'within 10% target tolerance' : 'target cannot be reached safely with current evidence'}</div>}
      {suggestions.data?.blockers.map((blocker) => <p key={blocker} style={{ color: 'var(--warning)', fontSize: 12 }}>{blocker}</p>)}
      <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
        {suggestions.data?.proposals.map((proposal) => <article key={proposal.id} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, opacity: proposal.status === 'accepted' ? 0.68 : 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><div><strong>{proposal.title}</strong><span className="hint"> · {proposal.kind} · {proposal.provenance} · {Math.round(proposal.confidence * 100)}% confidence</span></div><button disabled={proposal.status === 'accepted' || apply.isPending} onClick={() => apply.mutate(proposal.id)}>{proposal.status === 'accepted' ? 'Accepted' : apply.isPending ? 'Applying…' : 'Accept proposal'}</button></div>
          <p style={{ fontSize: 12, marginBottom: 6 }}>{proposal.rationale}</p>
          {proposal.kind === 'trim' && proposal.omitted_text && <details><summary style={{ fontSize: 12 }}>Preview omitted transcript</summary><p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{proposal.omitted_text}</p></details>}
          {proposal.citations.map((citation, index) => <div key={`${citation.source_asset_id}-${index}`} style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{citation.scene_id} · {(citation.source_in_ms / 1000).toFixed(1)}–{(citation.source_out_ms / 1000).toFixed(1)}s · {citation.evidence}{citation.excerpt ? ` · “${citation.excerpt}”` : ''}</div>)}
          {proposal.warnings.map((warning) => <div key={warning} style={{ color: 'var(--warning)', fontSize: 11, marginTop: 4 }}>{warning}</div>)}
        </article>)}
      </div>
      {suggestions.isError && <p role="alert" style={{ color: 'var(--danger)' }}>{suggestions.error instanceof Error ? suggestions.error.message : 'Suggestions failed.'}</p>}
      {apply.isError && <p role="alert" style={{ color: 'var(--danger)' }}>{apply.error instanceof Error ? apply.error.message : 'Proposal could not be applied.'}</p>}
    </section>
  );
}
