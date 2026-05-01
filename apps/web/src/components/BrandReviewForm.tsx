import type { DesignMdFrontMatter, TypographyLevel } from '@vpa/shared';

function defaultVpa() {
  return {
    voice: { tone: '', avoid: [] as string[] },
    audio: { music_mood: null, sonic_logo: null },
    logo: { primary: null, mono: null, safe_zone_ratio: 0.25 },
    lower_thirds: {
      template: 'bar-left-accent' as const,
      bg: '{colors.primary}',
      fg: '{colors.neutral}',
    },
    taglines: [] as string[],
  };
}

interface Props {
  value: DesignMdFrontMatter;
  onChange: (v: DesignMdFrontMatter) => void;
}

export function BrandReviewForm({ value, onChange }: Props) {
  const vpa = value.vpa ?? defaultVpa();

  const setField = <K extends keyof DesignMdFrontMatter>(
    key: K,
    val: DesignMdFrontMatter[K],
  ) => onChange({ ...value, [key]: val });

  const setColor = (key: string, hex: string) => {
    setField('colors', { ...value.colors, [key]: hex });
  };

  const setTypographyLevel = (levelName: string, patch: Partial<TypographyLevel>) => {
    const current = (value.typography as Record<string, TypographyLevel>)[levelName] ?? { fontFamily: '' };
    setField('typography', { ...value.typography, [levelName]: { ...current, ...patch } } as Record<string, TypographyLevel>);
  };

  const setVpa = (patch: Partial<typeof vpa>) => {
    onChange({ ...value, vpa: { ...vpa, ...patch } });
  };

  const colorEntries = Object.entries(value.colors);
  const typographyEntries = Object.entries(value.typography) as [string, TypographyLevel][];
  const roundedEntries = Object.entries(value.rounded ?? {});
  const spacingEntries = Object.entries(value.spacing ?? {});

  return (
    <div className="review-form">
      {/* Identity */}
      <fieldset>
        <legend>Identity</legend>
        <label>
          Name
          <input
            value={value.name}
            onChange={(e) => setField('name', e.target.value)}
          />
        </label>
        <label>
          Description
          <textarea
            rows={2}
            value={value.description ?? ''}
            onChange={(e) =>
              setField('description', e.target.value || undefined)
            }
          />
        </label>
      </fieldset>

      {/* Colors */}
      <fieldset>
        <legend>Colors ({colorEntries.length})</legend>
        <div className="color-grid">
          {colorEntries.map(([key, hex]) => (
            <div className="color-row" key={key}>
              <div
                className="color-swatch"
                style={{ background: hex as string }}
              />
              <span className="color-name">{key}</span>
              <input
                className="color-input"
                value={hex as string}
                onChange={(e) => setColor(key, e.target.value)}
              />
            </div>
          ))}
        </div>
      </fieldset>

      {/* Typography */}
      <fieldset>
        <legend>Typography ({typographyEntries.length} levels)</legend>
        {typographyEntries.map(([levelName, level]) => (
          <div key={levelName} className="typography-level">
            <strong>{levelName}</strong>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <label>
                fontFamily
                <input
                  value={level.fontFamily}
                  onChange={(e) => setTypographyLevel(levelName, { fontFamily: e.target.value })}
                />
              </label>
              <label>
                fontSize
                <input
                  value={level.fontSize ?? ''}
                  onChange={(e) => setTypographyLevel(levelName, { fontSize: e.target.value || undefined })}
                />
              </label>
              <label>
                fontWeight
                <input
                  type="number"
                  step={100}
                  min={100}
                  max={900}
                  value={level.fontWeight ?? ''}
                  onChange={(e) => setTypographyLevel(levelName, { fontWeight: e.target.value ? Number(e.target.value) : undefined })}
                />
              </label>
              <label>
                lineHeight
                <input
                  value={level.lineHeight ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    const num = parseFloat(v);
                    setTypographyLevel(levelName, {
                      lineHeight: v ? (Number.isFinite(num) && !v.match(/[a-z%]/i) ? num : v) : undefined,
                    });
                  }}
                />
              </label>
            </div>
          </div>
        ))}
      </fieldset>

      {/* Rounded */}
      {roundedEntries.length > 0 && (
        <fieldset>
          <legend>Rounded</legend>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            {roundedEntries.map(([key, val]) => (
              <label key={key}>
                {key}
                <input
                  value={val as string}
                  onChange={(e) => setField('rounded', { ...value.rounded, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {/* Spacing */}
      {spacingEntries.length > 0 && (
        <fieldset>
          <legend>Spacing</legend>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            {spacingEntries.map(([key, val]) => (
              <label key={key}>
                {key}
                <input
                  value={String(val)}
                  onChange={(e) => {
                    const v = e.target.value;
                    const num = parseFloat(v);
                    setField('spacing', {
                      ...value.spacing,
                      [key]: Number.isFinite(num) && !v.match(/[a-z%]/i) ? num : v,
                    });
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {/* Voice & Tone */}
      <fieldset>
        <legend>Voice &amp; Tone</legend>
        <label>
          Tone
          <textarea
            rows={3}
            value={vpa.voice.tone}
            onChange={(e) =>
              setVpa({ voice: { ...vpa.voice, tone: e.target.value } })
            }
          />
        </label>
      </fieldset>

      {/* Lower Thirds */}
      <fieldset>
        <legend>Lower Thirds</legend>
        <label>
          Template
          <select
            value={vpa.lower_thirds.template}
            onChange={(e) =>
              setVpa({
                lower_thirds: {
                  ...vpa.lower_thirds,
                  template: e.target.value as 'bar-left-accent' | 'centered-fade' | 'minimal-line',
                },
              })
            }
          >
            <option value="bar-left-accent">bar-left-accent</option>
            <option value="centered-fade">centered-fade</option>
            <option value="minimal-line">minimal-line</option>
          </select>
        </label>
      </fieldset>

      {/* Taglines */}
      <fieldset>
        <legend>Taglines</legend>
        {vpa.taglines.map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <input
              style={{ flex: 1 }}
              value={t}
              onChange={(e) => {
                const next = [...vpa.taglines];
                next[i] = e.target.value;
                setVpa({ taglines: next });
              }}
            />
            <button
              type="button"
              onClick={() =>
                setVpa({ taglines: vpa.taglines.filter((_, j) => j !== i) })
              }
            >
              x
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setVpa({ taglines: [...vpa.taglines, ''] })}
        >
          + Add tagline
        </button>
      </fieldset>
    </div>
  );
}
