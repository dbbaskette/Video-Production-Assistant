import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ideationApi } from '../lib/api.js';
import { DEFAULT_PRODUCTION_BRIEF, type ProductionBrief } from '@vpa/shared';
import { ChatMessage } from '../components/ChatMessage.js';
import { StoryboardPreview } from '../components/StoryboardPreview.js';

export function Ideation() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Load existing session
  const { data: session } = useQuery({
    queryKey: ['ideation', projectId],
    queryFn: () => ideationApi.getSession(projectId!),
    enabled: !!projectId,
  });
  const { data: project } = useQuery({ queryKey: ['project', projectId], queryFn: () => api.getProject(projectId!), enabled: !!projectId });

  const messages = session?.messages ?? [];
  const proposedScenes = session?.proposedScenes ?? [];
  const { data: acceptPreview } = useQuery({ queryKey: ['ideation-accept-preview', projectId], queryFn: () => ideationApi.acceptPreview(projectId!), enabled: !!projectId && proposedScenes.length > 0 });

  // Send message mutation. On failure the sent text is restored into the
  // input (it was cleared optimistically) and a retry banner is shown —
  // previously a network/model error silently destroyed the message.
  const sendMutation = useMutation({
    mutationFn: (content: string) => ideationApi.sendMessage(projectId!, content),
    onSuccess: () => {
      setFailedMessage(null);
      queryClient.invalidateQueries({ queryKey: ['ideation', projectId] });
    },
    onError: (_err, content) => {
      setFailedMessage(content);
      setInput((prev) => (prev.trim().length > 0 ? prev : content));
    },
  });

  // Accept storyboard mutation
  const acceptMutation = useMutation({
    mutationFn: () => ideationApi.accept(projectId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      navigate(`/project/${projectId}/storyboard`);
    },
  });

  const proposalMutation = useMutation({
    mutationFn: (operation: Parameters<typeof ideationApi.editProposal>[1]) => ideationApi.editProposal(projectId!, operation),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ideation', projectId] }); queryClient.invalidateQueries({ queryKey: ['ideation-accept-preview', projectId] }); },
  });
  const briefMutation = useMutation({
    mutationFn: (brief: ProductionBrief) => api.updateProductionBrief(projectId!, brief),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
  });

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || sendMutation.isPending) return;
    setInput('');
    sendMutation.mutate(trimmed);
  };

  const handleRetryFailed = () => {
    if (failedMessage == null || sendMutation.isPending) return;
    setFailedMessage(null);
    setInput('');
    sendMutation.mutate(failedMessage);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleRefineScene = (sceneId: string, sceneName: string) => {
    const msg = `Please refine scene "${sceneName}" (${sceneId}): `;
    setInput(msg);
  };

  const moveScene = (sceneId: string, direction: -1 | 1) => {
    const ids = proposedScenes.map((scene) => scene.id);
    const from = ids.indexOf(sceneId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    proposalMutation.mutate({ type: 'reorder', sceneIds: ids });
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Left column — Chat */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--border)',
          minWidth: 0,
        }}
      >
        {/* Chat header */}
        <div
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--border)',
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          Demo Ideation
        </div>

        {project && <details style={{ borderBottom: '1px solid var(--border)', padding: '12px 20px' }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Production brief</summary>
          <form key={`${project.id}-${JSON.stringify(project.production_brief)}`} onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const brandName = String(data.get('brandName') ?? '').trim(); const brandColor = String(data.get('brandColor') ?? '').trim(); briefMutation.mutate({ version: 1, purpose: String(data.get('purpose') ?? ''), audience: String(data.get('audience') ?? ''), target_duration_sec: Number(data.get('duration')), aspect_ratio: String(data.get('ratio')) as ProductionBrief['aspect_ratio'], tone: String(data.get('tone')) as ProductionBrief['tone'], brand: brandName ? { name: brandName, ...(brandColor ? { primary_color: brandColor } : {}) } : null }); }} style={{ display: 'grid', gap: 8, marginTop: 10 }}>
            <input name="purpose" aria-label="Video purpose" defaultValue={(project.production_brief ?? DEFAULT_PRODUCTION_BRIEF).purpose} placeholder="Purpose" />
            <input name="audience" aria-label="Target audience" defaultValue={(project.production_brief ?? DEFAULT_PRODUCTION_BRIEF).audience} placeholder="Audience" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}><input name="duration" aria-label="Target duration seconds" type="number" min={15} max={3600} defaultValue={(project.production_brief ?? DEFAULT_PRODUCTION_BRIEF).target_duration_sec} /><select name="ratio" aria-label="Aspect ratio" defaultValue={(project.production_brief ?? DEFAULT_PRODUCTION_BRIEF).aspect_ratio}><option>16:9</option><option>9:16</option><option>1:1</option></select></div>
            <select name="tone" aria-label="Tone" defaultValue={(project.production_brief ?? DEFAULT_PRODUCTION_BRIEF).tone}>{['clear', 'conversational', 'energetic', 'executive', 'educational'].map((tone) => <option key={tone}>{tone}</option>)}</select>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 88px', gap: 8 }}><input name="brandName" aria-label="Basic brand name" defaultValue={(project.production_brief ?? DEFAULT_PRODUCTION_BRIEF).brand?.name ?? ''} placeholder="Brand (optional)" /><input name="brandColor" aria-label="Brand primary color" type="color" defaultValue={(project.production_brief ?? DEFAULT_PRODUCTION_BRIEF).brand?.primary_color ?? '#2563eb'} /></div>
            <button type="submit" disabled={briefMutation.isPending}>{briefMutation.isPending ? 'Saving…' : 'Save brief'}</button>
          </form>
        </details>}

        {/* Messages */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '24px',
          }}
        >
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--fg-muted)', marginTop: 60 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>💡</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                What would you like to demo?
              </div>
              <div style={{ fontSize: 13, maxWidth: 400, margin: '0 auto', lineHeight: 1.6 }}>
                Describe your demo topic, target audience, and any key points you want to cover.
                AI will propose a storyboard with scenes you can refine.
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <ChatMessage
              key={msg.id}
              role={msg.role}
              content={msg.content}
              scenes={msg.scenes}
              timestamp={msg.timestamp}
            />
          ))}

          {sendMutation.isPending && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 16 }}>
              <div
                style={{
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: '12px 16px',
                  color: 'var(--fg-muted)',
                  fontSize: 14,
                }}
              >
                Thinking…
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Send-failure banner — the failed message is preserved and can be retried */}
        {failedMessage !== null && !sendMutation.isPending && (
          <div
            role="alert"
            style={{
              margin: '0 24px',
              padding: '10px 14px',
              background: 'var(--danger-bg)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 13,
              color: 'var(--danger)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ flex: 1 }}>
              Your last message couldn't be sent. It's been restored below — retry when ready.
            </span>
            <button onClick={handleRetryFailed} disabled={sendMutation.isPending}>
              Retry
            </button>
            <button
              onClick={() => setFailedMessage(null)}
              aria-label="Dismiss"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--danger)',
                cursor: 'pointer',
                padding: 4,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Input */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: 8,
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you want to demo…"
            rows={2}
            style={{
              flex: 1,
              resize: 'none',
              minHeight: 44,
            }}
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

      {/* Right column — Storyboard preview */}
      <div
        style={{
          width: 380,
          minWidth: 380,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg)',
        }}
      >
        {/* Preview header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>Storyboard</span>
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            {proposedScenes.length} {proposedScenes.length === 1 ? 'scene' : 'scenes'}
          </span>
        </div>

        {/* Scene list */}
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 16px' }}>
          <StoryboardPreview scenes={proposedScenes} onRefineScene={handleRefineScene} onUpdateScene={(sceneId, patch) => proposalMutation.mutate({ type: 'update', sceneId, patch })} onDeleteScene={(sceneId) => proposalMutation.mutate({ type: 'delete', sceneId })} onMoveScene={moveScene} />
          <button onClick={() => proposalMutation.mutate({ type: 'add', scene: { id: `scene-${Date.now()}`, name: 'New scene', description: '', type: 'desktop' } })} style={{ width: '100%', marginTop: 10 }}>+ Add scene</button>
          {proposalMutation.isError && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>The proposal edit could not be saved. Your previous plan is unchanged.</div>}
        </div>

        {/* Accept button */}
        <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
          {acceptPreview?.mode === 'replace' && <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 8 }}>Accepting replaces {acceptPreview.removed.length} unsourced scene{acceptPreview.removed.length === 1 ? '' : 's'} and preserves {acceptPreview.preserved.length} source-backed scene{acceptPreview.preserved.length === 1 ? '' : 's'}.</div>}
          <button
            className="primary"
            onClick={() => acceptMutation.mutate()}
            disabled={proposedScenes.length === 0 || acceptMutation.isPending}
            style={{
              width: '100%',
              padding: '12px',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            {acceptMutation.isPending ? 'Creating…' : 'Accept & Create Storyboard'}
          </button>
          {acceptMutation.error && (
            <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8, textAlign: 'center' }}>
              {acceptMutation.error instanceof Error ? acceptMutation.error.message : 'Failed to create storyboard'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
