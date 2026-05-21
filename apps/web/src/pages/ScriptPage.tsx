/**
 * Script page — project-wide list of every scene + its script status.
 *
 * Same shape as the Narration / Lower Thirds pages. Each row deep-links into
 * the scene's Script tab where the actual writing / regenerating happens.
 *
 * Scripts feed the narration pipeline but are also useful on their own (the
 * dialog version, monologue version, and the LLM-generated draft are all
 * editable text). This page surfaces "which scenes have a script and which
 * don't" so the user doesn't have to click into every scene to find out.
 */

import { useParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, FileText, MessageSquare } from 'lucide-react';
import { storyboardApi } from '../lib/api.js';
import { STATUS_COLOR } from '../lib/palette.js';
import type { ProjectTrackerEntry, Scene } from '@vpa/shared';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

function scriptOf(scene: Scene): string | null {
  // Prefer the active `script` field; fall back to the legacy / per-mode
  // snapshots so a scene that was switched to dialog mode still reads as
  // "has a script" here.
  const n = scene.narration;
  return n?.script || n?.monologueScript || n?.dialogScript || null;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function ScriptPage() {
  const { project } = useOutletContext<WorkspaceContext>();
  const { projectId } = useParams<{ projectId: string }>();
  void project;

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const scenes: Scene[] = storyboard?.scenes ?? [];
  const hasStoryboard = storyboard != null && scenes.length > 0;
  const withScripts = scenes.filter((s) => !!scriptOf(s));
  const totalWords = withScripts.reduce((sum, s) => {
    const text = scriptOf(s);
    return sum + (text ? countWords(text) : 0);
  }, 0);

  return (
    <div style={{ padding: '40px 48px', maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Script</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
        {!hasStoryboard
          ? 'Build a storyboard first — scripts apply to each scene.'
          : withScripts.length === 0
            ? 'Scripts are optional. Write or AI-generate them scene-by-scene below.'
            : `${withScripts.length} of ${scenes.length} scenes have scripts · ${totalWords.toLocaleString()} words total.`}
      </p>

      {hasStoryboard && (
        <div style={{ marginTop: 24 }}>
          <SceneList scenes={scenes} projectId={projectId!} />

          {withScripts.length === 0 && (
            <p
              style={{
                marginTop: 16,
                fontSize: 12,
                color: 'var(--fg-muted)',
                lineHeight: 1.6,
              }}
            >
              You can skip scripts entirely — the project will render without narration.
              Or click into a scene's Script tab to generate a draft from the recording.
            </p>
          )}
        </div>
      )}

      {!hasStoryboard && (
        <div
          style={{
            marginTop: 32,
            padding: 20,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
          }}
        >
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: 0 }}>
            No storyboard yet.{' '}
            <Link to={`/project/${projectId}/recordings`} style={{ color: 'var(--accent)' }}>
              Upload recordings
            </Link>{' '}
            to get started.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────

function SceneList({ scenes, projectId }: { scenes: Scene[]; projectId: string }) {
  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 20,
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 12,
        }}
      >
        Scenes
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {scenes.map((scene, i) => (
          <SceneRow key={scene.id} index={i} scene={scene} projectId={projectId} />
        ))}
      </div>
    </div>
  );
}

function SceneRow({ index, scene, projectId }: { index: number; scene: Scene; projectId: string }) {
  const script = scriptOf(scene);
  const hasScript = !!script;
  const hasRecording = !!scene.recording;
  const mode = scene.narration?.mode;
  const wordCount = script ? countWords(script) : 0;
  // First ~80 chars of the script as an inline preview. Strips emotive tags
  // like `[warm]` that the TTS engine uses, so the preview reads as plain
  // narration prose.
  const preview = script
    ? script.replace(/\[[a-zA-Z]+\]\s*/g, '').trim().slice(0, 80)
    : '';

  return (
    <Link
      to={`/project/${projectId}/scene/${scene.id}?tab=Script`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        background: 'var(--surface)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border)',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color 120ms',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <span
        style={{
          width: 24,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: hasScript ? STATUS_COLOR.success : 'var(--fg-dim)',
        }}
      >
        {hasScript ? (
          <CheckCircle2 size={18} strokeWidth={1.8} aria-hidden />
        ) : (
          <Circle size={18} strokeWidth={1.5} aria-hidden />
        )}
      </span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--fg-muted)',
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontVariantNumeric: 'tabular-nums',
          minWidth: 24,
        }}
      >
        {String(index + 1).padStart(2, '0')}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {scene.name}
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--fg-muted)',
            marginTop: 2,
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {hasScript ? (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <FileText size={11} strokeWidth={1.8} aria-hidden />
                {wordCount} words
              </span>
              {mode === 'dialog' && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <MessageSquare size={11} strokeWidth={1.8} aria-hidden />
                  Dialog
                </span>
              )}
              {/* Inline preview — first line of the script with emotive tags
                  stripped. Keeps the row scannable without opening every scene. */}
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 420,
                  color: 'var(--fg-dim)',
                  fontStyle: 'italic',
                }}
                title={preview}
              >
                “{preview}{preview.length >= 80 ? '…' : ''}”
              </span>
            </>
          ) : (
            <span style={{ color: 'var(--fg-dim)' }}>
              {hasRecording ? 'No script' : 'No recording yet'}
            </span>
          )}
        </div>
      </div>
      <span
        style={{
          fontSize: 12,
          color: 'var(--fg-muted)',
          padding: '4px 10px',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {hasScript ? 'Open' : hasRecording ? '+ Write' : 'Open'}
      </span>
    </Link>
  );
}
