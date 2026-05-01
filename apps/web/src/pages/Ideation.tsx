import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ideationApi } from '../lib/api.js';
import { ChatMessage } from '../components/ChatMessage.js';
import { StoryboardPreview } from '../components/StoryboardPreview.js';

export function Ideation() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Load existing session
  const { data: session } = useQuery({
    queryKey: ['ideation', projectId],
    queryFn: () => ideationApi.getSession(projectId!),
    enabled: !!projectId,
  });

  const messages = session?.messages ?? [];
  const proposedScenes = session?.proposedScenes ?? [];

  // Send message mutation
  const sendMutation = useMutation({
    mutationFn: (content: string) => ideationApi.sendMessage(projectId!, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ideation', projectId] });
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
          <StoryboardPreview scenes={proposedScenes} onRefineScene={handleRefineScene} />
        </div>

        {/* Accept button */}
        <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
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
