import type { Scene } from '@vpa/shared';

interface Props {
  role: 'user' | 'assistant';
  content: string;
  scenes?: Scene[];
  timestamp: string;
}

const typeBadgeColors: Record<string, string> = {
  desktop: '#7aa2f7',
  terminal: '#5e8a3a',
  browser: '#f4a83a',
  slide: '#c25d5d',
};

export function ChatMessage({ role, content, scenes, timestamp }: Props) {
  const isUser = role === 'user';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 16,
      }}
    >
      <div
        style={{
          maxWidth: '85%',
          background: isUser ? 'var(--accent-bg)' : 'var(--bg-elev)',
          border: `1px solid ${isUser ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 12,
          padding: '12px 16px',
        }}
      >
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 6 }}>
          {isUser ? 'You' : 'AI'} · {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
          {content}
        </div>

        {/* Scene chips */}
        {scenes && scenes.length > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
              Proposed Scenes ({scenes.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {scenes.map((scene) => (
                <div
                  key={scene.id}
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '8px 10px',
                    fontSize: 13,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: typeBadgeColors[scene.type] ?? '#666',
                        color: '#fff',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                      }}
                    >
                      {scene.type}
                    </span>
                    <span style={{ fontWeight: 600 }}>{scene.name}</span>
                  </div>
                  <div style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 12 }}>
                    {scene.description}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
