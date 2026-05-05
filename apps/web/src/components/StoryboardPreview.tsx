import type { Scene } from '@vpa/shared';
import { SCENE_TYPE_COLOR } from '../lib/palette.js';

const typeBadgeColors: Record<string, string> = SCENE_TYPE_COLOR;

interface Props {
  scenes: Scene[];
  onRefineScene?: (sceneId: string, sceneName: string) => void;
}

export function StoryboardPreview({ scenes, onRefineScene }: Props) {
  if (scenes.length === 0) {
    return (
      <div style={{ color: 'var(--fg-muted)', textAlign: 'center', padding: '40px 20px' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
        <div style={{ fontSize: 14 }}>No scenes yet</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>
          Describe what you want to demo in the chat and AI will propose scenes.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {scenes.map((scene, idx) => (
        <div
          key={scene.id}
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '12px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                  fontWeight: 600,
                  minWidth: 20,
                }}
              >
                {idx + 1}
              </span>
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
              <span style={{ fontWeight: 600, fontSize: 14 }}>{scene.name}</span>
            </div>
            {onRefineScene && (
              <button
                onClick={() => onRefineScene(scene.id, scene.name)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                  fontSize: 13,
                  padding: '2px 6px',
                }}
                title={`Refine "${scene.name}"`}
              >
                ✏️
              </button>
            )}
          </div>
          <div style={{ color: 'var(--fg-muted)', marginTop: 6, fontSize: 13, lineHeight: 1.5, paddingLeft: 28 }}>
            {scene.description}
          </div>
        </div>
      ))}
    </div>
  );
}
