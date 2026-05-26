/**
 * LowerThirdsTimeline — visual scrubber for arranging lower-thirds along
 * a scene's recording duration.
 *
 * Pre-existing UI used numeric `in_sec` / `out_sec` inputs per LT card —
 * accurate but slow to compare, and overlaps were invisible until render
 * time. The timeline renders each LT as a draggable band over a track
 * sized to the recording duration so the user can see ordering + overlap
 * at a glance and drag to adjust instead of typing.
 *
 * Drag zones per LT band:
 *   left edge  →  resize from the start (changes in_sec)
 *   right edge →  resize from the end   (changes out_sec)
 *   middle     →  shift both edges by the same delta
 *
 * The component is uncontrolled-during-drag: it tracks the in-progress
 * drag in local state and commits to the parent via `onChange` only when
 * the pointer is released. This keeps render churn low and avoids
 * re-flowing the LT cards below the timeline on every pixel of motion.
 */
import { useEffect, useRef, useState } from 'react';
import type { LowerThird } from '@vpa/shared';

export interface LowerThirdsTimelineProps {
  lts: LowerThird[];
  /** Total recording duration in seconds — sets the track scale. */
  durationSec: number;
  /** Called once on pointer-up with the new in/out for the edited LT.
   *  No-op during the drag itself. */
  onChange: (idx: number, in_sec: number, out_sec: number) => void;
  /** Highlight a specific LT (e.g. corresponds to the card focused below). */
  selectedIdx?: number | null;
  onSelect?: (idx: number) => void;
}

type DragMode = 'move' | 'resize-left' | 'resize-right';

interface DragState {
  ltIdx: number;
  mode: DragMode;
  /** Pixel where the drag started, in container-local coordinates. */
  startX: number;
  /** Original in/out from before the drag began. Used to compute the new values. */
  origIn: number;
  origOut: number;
}

const TRACK_HEIGHT = 56;
const BAND_HEIGHT = 26;
const EDGE_HIT_PX = 8;
const MIN_LT_DURATION_SEC = 0.5;

export function LowerThirdsTimeline({ lts, durationSec, onChange, selectedIdx, onSelect }: LowerThirdsTimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  /** Per-LT local override during drag, keyed by index → {in_sec, out_sec}. */
  const [overrides, setOverrides] = useState<Map<number, { in_sec: number; out_sec: number }>>(new Map());

  // Measure track width on mount + resize so pixel↔second conversion stays
  // accurate when the user resizes the window.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setTrackWidth(el.getBoundingClientRect().width));
    obs.observe(el);
    setTrackWidth(el.getBoundingClientRect().width);
    return () => obs.disconnect();
  }, []);

  const pxPerSec = trackWidth > 0 && durationSec > 0 ? trackWidth / durationSec : 0;
  const secsPerPx = pxPerSec > 0 ? 1 / pxPerSec : 0;

  // Resolve display in/out — overrides take precedence (drag in progress).
  function effective(idx: number): { in_sec: number; out_sec: number } {
    const o = overrides.get(idx);
    if (o) return o;
    const lt = lts[idx];
    return { in_sec: lt?.in_sec ?? 0, out_sec: lt?.out_sec ?? 0 };
  }

  function startDrag(e: React.PointerEvent, ltIdx: number, mode: DragMode) {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const lt = lts[ltIdx];
    if (!lt) return;
    setDrag({
      ltIdx,
      mode,
      startX: e.clientX - rect.left,
      origIn: lt.in_sec,
      origOut: lt.out_sec,
    });
    onSelect?.(ltIdx);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag || secsPerPx === 0) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const currentX = e.clientX - rect.left;
    const deltaSec = (currentX - drag.startX) * secsPerPx;

    let inSec = drag.origIn;
    let outSec = drag.origOut;
    if (drag.mode === 'move') {
      const length = drag.origOut - drag.origIn;
      inSec = drag.origIn + deltaSec;
      outSec = inSec + length;
      // Clamp to track bounds, preserving length.
      if (inSec < 0) {
        inSec = 0;
        outSec = length;
      }
      if (outSec > durationSec) {
        outSec = durationSec;
        inSec = durationSec - length;
      }
    } else if (drag.mode === 'resize-left') {
      inSec = Math.min(drag.origOut - MIN_LT_DURATION_SEC, Math.max(0, drag.origIn + deltaSec));
    } else if (drag.mode === 'resize-right') {
      outSec = Math.max(drag.origIn + MIN_LT_DURATION_SEC, Math.min(durationSec, drag.origOut + deltaSec));
    }
    // Round to 0.1s to keep the values sane in YAML.
    inSec = Math.round(inSec * 10) / 10;
    outSec = Math.round(outSec * 10) / 10;
    setOverrides((prev) => new Map(prev).set(drag.ltIdx, { in_sec: inSec, out_sec: outSec }));
  }

  function endDrag() {
    if (!drag) return;
    const override = overrides.get(drag.ltIdx);
    if (override && (override.in_sec !== drag.origIn || override.out_sec !== drag.origOut)) {
      onChange(drag.ltIdx, override.in_sec, override.out_sec);
    }
    setDrag(null);
    setOverrides((prev) => {
      const next = new Map(prev);
      next.delete(drag.ltIdx);
      return next;
    });
  }

  // Tick marks every 5s — keeps the track scannable without crowding.
  const tickInterval = durationSec > 60 ? 10 : 5;
  const ticks: number[] = [];
  for (let t = 0; t <= durationSec; t += tickInterval) ticks.push(t);

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 4,
          fontSize: 11,
          color: 'var(--fg-muted)',
        }}
      >
        <span>Timeline · drag to position; ends to resize</span>
        <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontVariantNumeric: 'tabular-nums' }}>
          0s — {durationSec.toFixed(1)}s
        </span>
      </div>
      <div
        ref={trackRef}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
        style={{
          position: 'relative',
          height: TRACK_HEIGHT,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        {/* Time ticks */}
        {ticks.map((t) => {
          const pct = (t / durationSec) * 100;
          return (
            <div key={t}>
              <div
                style={{
                  position: 'absolute',
                  left: `${pct}%`,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: 'var(--border)',
                  opacity: 0.5,
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  left: `calc(${pct}% + 4px)`,
                  top: 2,
                  fontSize: 9,
                  color: 'var(--fg-dim)',
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                }}
              >
                {t}s
              </span>
            </div>
          );
        })}

        {/* LT bands */}
        {lts.map((lt, idx) => {
          const eff = effective(idx);
          const leftPct = Math.max(0, Math.min(100, (eff.in_sec / durationSec) * 100));
          const widthPct = Math.max(0.5, Math.min(100 - leftPct, ((eff.out_sec - eff.in_sec) / durationSec) * 100));
          const isSelected = selectedIdx === idx;
          const isDragging = drag?.ltIdx === idx;
          return (
            <div
              key={idx}
              onPointerDown={(e) => startDrag(e, idx, 'move')}
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                width: `${widthPct}%`,
                top: TRACK_HEIGHT - BAND_HEIGHT - 6,
                height: BAND_HEIGHT,
                background: isSelected || isDragging ? 'var(--accent)' : 'rgba(122, 162, 247, 0.5)',
                border: `1px solid ${isSelected || isDragging ? 'var(--accent)' : 'rgba(122, 162, 247, 0.7)'}`,
                borderRadius: 3,
                display: 'flex',
                alignItems: 'center',
                padding: '0 6px',
                gap: 4,
                cursor: drag ? 'grabbing' : 'grab',
                color: '#fff',
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                boxShadow: isSelected || isDragging ? '0 0 0 2px var(--bg) inset' : undefined,
              }}
              title={`${lt.title} · ${eff.in_sec.toFixed(1)}s – ${eff.out_sec.toFixed(1)}s`}
            >
              {/* left resize handle */}
              <div
                onPointerDown={(e) => startDrag(e, idx, 'resize-left')}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: EDGE_HIT_PX,
                  cursor: 'ew-resize',
                  background: isSelected || isDragging ? 'rgba(255,255,255,0.3)' : 'transparent',
                }}
                aria-label="Drag start"
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                #{idx + 1} {lt.title}
              </span>
              {/* right resize handle */}
              <div
                onPointerDown={(e) => startDrag(e, idx, 'resize-right')}
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: EDGE_HIT_PX,
                  cursor: 'ew-resize',
                  background: isSelected || isDragging ? 'rgba(255,255,255,0.3)' : 'transparent',
                }}
                aria-label="Drag end"
              />
            </div>
          );
        })}

        {/* Empty state */}
        {lts.length === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--fg-dim)',
              fontSize: 12,
              pointerEvents: 'none',
            }}
          >
            No lower thirds yet — recommended ones will appear here.
          </div>
        )}
      </div>
    </div>
  );
}
