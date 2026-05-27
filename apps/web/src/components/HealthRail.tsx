/**
 * HealthRail — fixed bottom-of-page strip that surfaces per-scene
 * production health on every project route.
 *
 * One chip per scene, each with four mini status dots:
 *   🎬 recording      ✍️ script-fit      🔊 TTS         ✨ render
 *
 * Click a chip to jump into the scene's most relevant tab (the worst
 * dimension). User can hide via the right-side × — preference persists in
 * localStorage.
 *
 * Pure consumer of the storyboard query cache + scene-health helpers; no
 * fetches of its own.
 */

import { useMemo, useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X, ChevronUp } from 'lucide-react';
import type { Scene } from '@vpa/shared';
import { storyboardApi } from '../lib/api.js';
import {
  computeSceneHealth,
  computeProjectWpm,
  type SceneHealth,
  type ScriptStatus,
} from '../lib/scene-health.js';
import { STATUS_COLOR } from '../lib/palette.js';

const STORAGE_KEY = 'vpa.healthRail.visible';

type Tone = 'ok' | 'warn' | 'issue' | 'absent';

function recordingTone(s: SceneHealth['recording']): Tone {
  return s === 'ok' ? 'ok' : 'issue';
}
function scriptTone(s: ScriptStatus): Tone {
  if (s === 'absent') return 'absent';
  if (s === 'over' || s === 'short') return 'warn';
  return 'ok';
}
function ttsTone(s: SceneHealth['tts']): Tone {
  return s === 'fresh' ? 'ok' : 'absent';
}
function renderTone(s: SceneHealth['render']): Tone {
  return s === 'fresh' ? 'ok' : 'absent';
}

const TONE_COLOR: Record<Tone, string> = {
  ok: STATUS_COLOR.success,
  warn: STATUS_COLOR.warn,
  issue: STATUS_COLOR.danger,
  absent: 'var(--border)',
};

function chooseLandingTab(h: SceneHealth): 'Recording' | 'Script' | 'Narration' | 'Lower Thirds' {
  if (h.recording === 'missing') return 'Recording';
  if (h.script === 'over' || h.script === 'short' || h.script === 'absent') return 'Script';
  if (h.tts === 'missing') return 'Narration';
  return 'Lower Thirds';
}

interface DotProps {
  tone: Tone;
  label: string;
}
function Dot({ tone, label }: DotProps) {
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: TONE_COLOR[tone],
        display: 'inline-block',
      }}
    />
  );
}

function SceneChip({
  index,
  scene,
  health,
  onClick,
}: {
  index: number;
  scene: Scene;
  health: SceneHealth;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`${scene.name} — click to open ${chooseLandingTab(health)}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 10px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        color: 'var(--fg)',
        cursor: 'pointer',
        fontSize: 11,
        whiteSpace: 'nowrap',
        transition: 'border-color 120ms',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <span style={{ color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>
        {String(index + 1).padStart(2, '0')}
      </span>
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <Dot tone={recordingTone(health.recording)} label={`recording: ${health.recording}`} />
        <Dot tone={scriptTone(health.script)} label={`script: ${health.script}`} />
        <Dot tone={ttsTone(health.tts)} label={`tts: ${health.tts}`} />
        <Dot tone={renderTone(health.render)} label={`render: ${health.render}`} />
      </span>
    </button>
  );
}

export function HealthRail() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === '1';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, visible ? '1' : '0');
  }, [visible]);

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const wpm = useMemo(() => computeProjectWpm(storyboard ?? null).wpm, [storyboard]);
  const rows = useMemo<{ scene: Scene; health: SceneHealth }[]>(() => {
    if (!storyboard) return [];
    return storyboard.scenes.map((s: Scene) => ({
      scene: s,
      health: computeSceneHealth(s, wpm),
    }));
  }, [storyboard, wpm]);

  if (!projectId || !storyboard || rows.length === 0) return null;

  if (!visible) {
    return (
      <button
        onClick={() => setVisible(true)}
        title="Show project health rail"
        style={{
          position: 'fixed',
          right: 16,
          bottom: 12,
          width: 28,
          height: 28,
          borderRadius: '50%',
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
        }}
      >
        <ChevronUp size={14} />
      </button>
    );
  }

  return (
    <div
      role="region"
      aria-label="Project health"
      style={{
        position: 'sticky',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: 'var(--bg-elev)',
        borderTop: '1px solid var(--border)',
        zIndex: 40,
        backdropFilter: 'blur(4px)',
      }}
    >
      <span
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 1,
          color: 'var(--fg-muted)',
          fontWeight: 600,
        }}
      >
        Health
      </span>
      <div
        style={{
          display: 'flex',
          gap: 6,
          overflowX: 'auto',
          flex: 1,
          paddingBottom: 2,
        }}
      >
        {rows.map(({ scene, health }, idx) => (
          <SceneChip
            key={scene.id}
            index={idx}
            scene={scene}
            health={health}
            onClick={() => {
              const tab = chooseLandingTab(health);
              navigate(
                `/project/${projectId}/storyboard?scene=${encodeURIComponent(scene.id)}&tab=${encodeURIComponent(tab)}`,
              );
            }}
          />
        ))}
      </div>
      <Legend />
      <button
        onClick={() => setVisible(false)}
        aria-label="Hide health rail"
        title="Hide rail"
        style={{
          marginLeft: 4,
          width: 22,
          height: 22,
          borderRadius: 4,
          border: 'none',
          background: 'transparent',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

function Legend() {
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 10,
        fontSize: 10,
        color: 'var(--fg-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      <span>🎬 rec</span>
      <span>✍ script</span>
      <span>🔊 tts</span>
      <span>✨ render</span>
    </span>
  );
}
