import { useMemo, useState, useEffect } from 'react';
import type { FrameInfo } from '../lib/api.js';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface FrameStylePickerProps {
  /** Current value. Both fields optional/nullable so the picker can render
   *  a "None" selection when both are unset. */
  value: {
    frameStyle?: string | null;
    frameBackground?: 'brand' | 'transparent' | string | null;
  };
  /** Called with the next desired value. Fully controlled — parent owns persistence. */
  onChange: (next: {
    frameStyle?: string | null;
    frameBackground?: 'brand' | 'transparent' | string | null;
  }) => void;
  /** Frames from framesApi.list(). Grouped by family in the picker. */
  frames: FrameInfo[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveRadioMode(
  bg: string | null | undefined,
): 'brand' | 'transparent' | 'custom' {
  if (!bg || bg === 'brand') return 'brand';
  if (bg === 'transparent') return 'transparent';
  return 'custom';
}

function initialCustomHex(bg: string | null | undefined): string {
  if (bg && bg !== 'brand' && bg !== 'transparent') return bg;
  return '#000000';
}

// ---------------------------------------------------------------------------
// Shared micro-styles (mirror VoicesTts eyebrow style)
// ---------------------------------------------------------------------------

const sectionLabel: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--fg-muted)',
  marginBottom: 8,
};

const tileBase: React.CSSProperties = {
  width: 80,
  height: 60,
  borderRadius: 6,
  cursor: 'pointer',
  background: 'var(--bg)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  userSelect: 'none',
  transition: 'border-color 120ms',
  padding: 0,
};

function tileStyle(active: boolean): React.CSSProperties {
  return {
    ...tileBase,
    border: active
      ? '2px solid var(--accent)'
      : '1px solid var(--border)',
  };
}

const selectStyle: React.CSSProperties = {
  padding: '7px 10px',
  fontSize: 13,
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  minWidth: 160,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FrameStylePicker({ value, onChange, frames }: FrameStylePickerProps) {
  // Group frames by family, preserving manifest order within each family.
  const byFamily = useMemo<[string, FrameInfo[]][]>(() => {
    const map = new Map<string, FrameInfo[]>();
    for (const f of frames) {
      const arr = map.get(f.family) ?? [];
      arr.push(f);
      map.set(f.family, arr);
    }
    return Array.from(map.entries());
  }, [frames]);

  // Resolve which frame / family is currently selected.
  const currentFrame = frames.find((f) => f.id === value.frameStyle) ?? null;
  const currentFamily = currentFrame?.family ?? null; // null = "None"

  // Variants for the active family (for the variant <select>).
  const familyVariants = useMemo<FrameInfo[]>(
    () => (currentFamily ? frames.filter((f) => f.family === currentFamily) : []),
    [frames, currentFamily],
  );

  // ---------------------------------------------------------------------------
  // Background radio state — internal only for the in-flight hex input.
  // ---------------------------------------------------------------------------
  const radioMode = deriveRadioMode(value.frameBackground);

  // Keep custom-hex text field as local state so users can type partial values.
  const [customHex, setCustomHex] = useState<string>(() =>
    initialCustomHex(value.frameBackground),
  );

  // Sync customHex when the parent passes a new external custom value.
  useEffect(() => {
    const bg = value.frameBackground;
    if (bg && bg !== 'brand' && bg !== 'transparent') {
      setCustomHex(bg);
    }
  }, [value.frameBackground]);

  const hexValid = HEX_RE.test(customHex);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleFamilyClick(family: string | null) {
    if (family === null) {
      // "None" tile — clear frameStyle.
      onChange({ ...value, frameStyle: null });
    } else {
      // Select first variant in the family.
      const variants = frames.filter((f) => f.family === family);
      const first = variants[0];
      if (!first) return;
      onChange({ ...value, frameStyle: first.id });
    }
  }

  function handleVariantChange(e: React.ChangeEvent<HTMLSelectElement>) {
    onChange({ ...value, frameStyle: e.target.value });
  }

  function handleRadioChange(mode: 'brand' | 'transparent' | 'custom') {
    if (mode === 'brand') {
      setCustomHex(initialCustomHex(value.frameBackground));
      onChange({ ...value, frameBackground: 'brand' });
    } else if (mode === 'transparent') {
      setCustomHex(initialCustomHex(value.frameBackground));
      onChange({ ...value, frameBackground: 'transparent' });
    }
    // For 'custom', don't fire onChange yet — wait for valid hex input.
  }

  function handleCustomHexChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    setCustomHex(raw);
    if (HEX_RE.test(raw)) {
      onChange({ ...value, frameBackground: raw });
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {/* ── Frame style section ────────────────────────────────────────── */}
      <div>
        <span style={sectionLabel}>Frame style</span>

        {/* Family thumbnail row */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          {/* "None" tile */}
          <button
            type="button"
            title="No frame"
            aria-pressed={currentFamily === null}
            onClick={() => handleFamilyClick(null)}
            style={{
              ...tileStyle(currentFamily === null),
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {/* circle-slash icon drawn inline */}
            <svg
              width={22}
              height={22}
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--fg-muted)"
              strokeWidth={1.8}
              strokeLinecap="round"
            >
              <circle cx={12} cy={12} r={9} />
              <line x1={5} y1={5} x2={19} y2={19} />
            </svg>
            <span
              style={{ fontSize: 10, color: 'var(--fg-muted)', letterSpacing: 0.3 }}
            >
              None
            </span>
          </button>

          {/* One tile per family */}
          {byFamily.map(([family, variants]) => {
            const representative = variants[0];
            const isActive = currentFamily === family;
            return (
              <button
                key={family}
                type="button"
                title={family}
                aria-pressed={isActive}
                onClick={() => handleFamilyClick(family)}
                style={tileStyle(isActive)}
              >
                {representative?.thumbnailUrl ? (
                  <img
                    src={representative.thumbnailUrl}
                    alt={family}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                    }}
                    draggable={false}
                  />
                ) : (
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--fg-muted)',
                      textAlign: 'center',
                      padding: '0 4px',
                      letterSpacing: 0.3,
                    }}
                  >
                    {family}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Family label row — caption under each tile */}
        {byFamily.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              marginTop: 4,
            }}
          >
            {/* spacer for the None tile */}
            <div style={{ width: 80 }} />
            {byFamily.map(([family]) => (
              <div
                key={family}
                style={{
                  width: 80,
                  fontSize: 10,
                  textAlign: 'center',
                  color:
                    currentFamily === family
                      ? 'var(--accent)'
                      : 'var(--fg-muted)',
                  letterSpacing: 0.3,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {family}
              </div>
            ))}
          </div>
        )}

        {/* Variant selector — only when a real family is selected */}
        {currentFamily !== null && familyVariants.length > 1 && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 0.6,
                color: 'var(--fg-muted)',
              }}
            >
              Variant
            </span>
            <select
              value={value.frameStyle ?? ''}
              onChange={handleVariantChange}
              style={selectStyle}
            >
              {familyVariants.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.variant}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── Background section ─────────────────────────────────────────── */}
      <div>
        <span style={sectionLabel}>Background</span>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          {/* brand */}
          <RadioOption
            id="fsp-bg-brand"
            checked={radioMode === 'brand'}
            onChange={() => handleRadioChange('brand')}
            label="brand"
          />

          {/* transparent */}
          <RadioOption
            id="fsp-bg-transparent"
            checked={radioMode === 'transparent'}
            onChange={() => handleRadioChange('transparent')}
            label="transparent"
          />

          {/* custom */}
          <label
            htmlFor="fsp-bg-custom-radio"
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          >
            <input
              id="fsp-bg-custom-radio"
              type="radio"
              name="fsp-bg"
              checked={radioMode === 'custom'}
              onChange={() => handleRadioChange('custom')}
              style={{ cursor: 'pointer' }}
            />
            <span style={{ fontSize: 13, color: 'var(--fg)' }}>custom:</span>
            <input
              type="text"
              value={customHex}
              onFocus={() => {
                // Switch radio to custom when the user focuses the hex field.
                if (radioMode !== 'custom') handleRadioChange('custom');
              }}
              onChange={handleCustomHexChange}
              placeholder="#RRGGBB"
              maxLength={7}
              style={{
                width: 90,
                padding: '5px 8px',
                fontSize: 13,
                fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
                background: 'var(--bg)',
                color: hexValid ? 'var(--fg)' : 'var(--danger)',
                border: `1px solid ${!hexValid && customHex.length > 1 ? 'var(--danger)' : 'var(--border)'}`,
                borderRadius: 6,
              }}
            />
            {/* Inline swatch preview */}
            {hexValid && (
              <span
                aria-hidden
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  border: '1px solid var(--border)',
                  background: customHex,
                  flexShrink: 0,
                }}
              />
            )}
            {!hexValid && customHex.length > 1 && (
              <span
                style={{ fontSize: 11, color: 'var(--danger)' }}
                role="alert"
              >
                use #RRGGBB
              </span>
            )}
          </label>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function RadioOption({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label
      htmlFor={id}
      style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
    >
      <input
        id={id}
        type="radio"
        name="fsp-bg"
        checked={checked}
        onChange={onChange}
        style={{ cursor: 'pointer' }}
      />
      <span style={{ fontSize: 13, color: 'var(--fg)' }}>{label}</span>
    </label>
  );
}
