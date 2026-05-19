import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { shotPlanApi, type ShotPlanStep } from '../lib/api.js';
import { ChatMessage } from './ChatMessage.js';

type Mode = 'empty' | 'chat' | 'accepted';

interface Props {
  projectId: string;
  sceneId: string;
}

export function ShotPlanSection({ projectId, sceneId }: Props) {
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [refining, setRefining] = useState(false);
  const [localTicked, setLocalTicked] = useState<Set<number>>(new Set());
  const chatEndRef = useRef<HTMLDivElement>(null);
  const lastInputRef = useRef<string>('');

  const { data, isLoading } = useQuery({
    queryKey: ['shot-plan', projectId, sceneId],
    queryFn: () => shotPlanApi.get(projectId, sceneId),
  });

  const sendMutation = useMutation({
    mutationFn: (content: string) => shotPlanApi.sendMessage(projectId, sceneId, content),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shot-plan', projectId, sceneId] }),
  });

  const acceptMutation = useMutation({
    mutationFn: () => shotPlanApi.accept(projectId, sceneId),
    onSuccess: () => {
      setRefining(false);
      qc.invalidateQueries({ queryKey: ['shot-plan', projectId, sceneId] });
      qc.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const discardMutation = useMutation({
    mutationFn: () => shotPlanApi.discard(projectId, sceneId),
    onSuccess: () => {
      setRefining(false);
      qc.invalidateQueries({ queryKey: ['shot-plan', projectId, sceneId] });
      qc.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const evictMutation = useMutation({
    mutationFn: () => shotPlanApi.evict(projectId, sceneId),
    onSuccess: () => {
      setRefining(false);
      qc.invalidateQueries({ queryKey: ['shot-plan', projectId, sceneId] });
    },
  });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.transcript.length]);

  if (isLoading || !data) {
    return (
      <section style={sectionStyle}>
        <Header>Shot Plan</Header>
        <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 13 }}>Loading…</div>
      </section>
    );
  }

  const hasSavedPlan = (data.savedPlan?.length ?? 0) > 0;
  const hasLiveSession = data.transcript.length > 0 || data.proposedSteps.length > 0;
  const mode: Mode = refining || (hasLiveSession && !hasSavedPlan)
    ? 'chat'
    : hasSavedPlan
    ? 'accepted'
    : 'empty';

  const handleSend = () => {
    const t = input.trim();
    if (!t || sendMutation.isPending) return;
    lastInputRef.current = t;
    setInput('');
    sendMutation.mutate(t);
  };

  const handleStartChat = () => {
    // The chat session is created server-side on the first POST /message; nothing
    // to do here besides flipping into chat mode.
    setRefining(true);
  };

  const handleCancel = () => {
    // If we have a previously-accepted plan, just drop the in-memory session — don't wipe disk.
    if (hasSavedPlan) {
      evictMutation.mutate();
    } else {
      // No saved plan: clearing the in-memory session is equivalent to DELETE (no-op on disk).
      discardMutation.mutate();
    }
  };

  return (
    <section style={sectionStyle}>
      <Header>Shot Plan</Header>

      {mode === 'empty' && (
        <div style={{ padding: 16 }}>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 12px' }}>
            Optional: get a step-by-step recording script the AI generates from this
            scene's intent. Refine via chat until it matches what you plan to record.
          </p>
          <button className="primary" onClick={handleStartChat}>
            Plan shots
          </button>
        </div>
      )}

      {mode === 'chat' && (
        <div style={{ display: 'flex', minHeight: 320 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {data.transcript.length === 0 && (
                <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
                  Describe what you want to record — apps, commands, what you want shown.
                </div>
              )}
              {data.transcript.map((t, i) => (
                <ChatMessage
                  key={`${t.at}-${i}`}
                  role={t.role}
                  content={t.content}
                  timestamp={t.at}
                />
              ))}
              {sendMutation.isPending && (
                <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 8 }}>Thinking…</div>
              )}
              {sendMutation.isError && (
                <div
                  style={{
                    marginTop: 8,
                    padding: 12,
                    border: '1px solid var(--danger, #d9534f)',
                    borderRadius: 6,
                    background: 'var(--bg)',
                    fontSize: 13,
                    color: 'var(--danger, #d9534f)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span>
                    {sendMutation.error instanceof Error
                      ? sendMutation.error.message
                      : 'Failed to reach the LLM.'}
                  </span>
                  <button
                    onClick={() => {
                      if (lastInputRef.current) sendMutation.mutate(lastInputRef.current);
                    }}
                    disabled={sendMutation.isPending || !lastInputRef.current}
                  >
                    Retry
                  </button>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Tell the AI what to add, remove, or clarify…"
                rows={2}
                style={{ flex: 1, resize: 'none' }}
              />
              <button
                className="primary"
                onClick={handleSend}
                disabled={!input.trim() || sendMutation.isPending}
                style={{ alignSelf: 'flex-end' }}
              >
                Send
              </button>
            </div>
          </div>

          <aside
            style={{
              width: 320,
              borderLeft: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ padding: 12, borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
              Proposed steps ({data.proposedSteps.length})
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
              {data.proposedSteps.length === 0 ? (
                <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>None yet.</div>
              ) : (
                <ol style={{ paddingLeft: 18, margin: 0 }}>
                  {data.proposedSteps.map((s) => (
                    <li key={s.index} style={{ marginBottom: 8, fontSize: 13, lineHeight: 1.4 }}>
                      <div>{s.action}</div>
                      {s.note && (
                        <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 2 }}>
                          {s.note}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
              <button
                className="primary"
                onClick={() => acceptMutation.mutate()}
                disabled={data.proposedSteps.length === 0 || acceptMutation.isPending}
                style={{ flex: 1 }}
              >
                Accept plan
              </button>
              <button onClick={handleCancel}>Cancel</button>
            </div>
          </aside>
        </div>
      )}

      {mode === 'accepted' && (
        <div style={{ padding: 16 }}>
          <ol style={{ paddingLeft: 22, margin: '0 0 16px' }}>
            {data.savedPlan!.map((s: ShotPlanStep) => (
              <li key={s.index} style={{ marginBottom: 10, fontSize: 14, lineHeight: 1.5 }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={localTicked.has(s.index)}
                    onChange={(e) => {
                      const next = new Set(localTicked);
                      if (e.target.checked) next.add(s.index);
                      else next.delete(s.index);
                      setLocalTicked(next);
                    }}
                    style={{ marginTop: 4 }}
                  />
                  <span>
                    <span style={{ textDecoration: localTicked.has(s.index) ? 'line-through' : 'none' }}>
                      {s.action}
                    </span>
                    {s.note && (
                      <span style={{ color: 'var(--fg-muted)', fontSize: 12, display: 'block', marginTop: 2 }}>
                        {s.note}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ol>
          <div style={{ display: 'flex', gap: 8 }}>
            <a
              href={`/projects/${projectId}/scenes/${sceneId}/shot-plan/print`}
              target="_blank"
              rel="noreferrer"
              className="primary"
              style={{ padding: '8px 12px', textDecoration: 'none', display: 'inline-block' }}
            >
              Open print view
            </a>
            <button onClick={() => setRefining(true)}>Refine</button>
            <button
              onClick={() => {
                if (confirm('Discard this shot plan? This cannot be undone.')) {
                  discardMutation.mutate();
                }
              }}
              style={{ marginLeft: 'auto' }}
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const sectionStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg-elev)',
  marginBottom: 16,
};

function Header({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}
