import type { DesignMdFrontMatter } from '@vpa/shared';

function defaultVpa() {
  return {
    voice: { tone: '', avoid: [] as string[] },
    audio: { music_mood: null, sonic_logo: null },
    logo: { primary: null, mono: null, safe_zone_ratio: 0.25 },
    lower_thirds: {
      template: 'bar-left-accent' as const,
      bg: '{colors.primary}',
      fg: '{colors.surface}',
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

  const setVpa = (patch: Partial<typeof vpa>) => {
    onChange({ ...value, vpa: { ...vpa, ...patch } });
  };

  const colorEntries = Object.entries(value.colors);

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
        <legend>Colors</legend>
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
        <legend>Typography</legend>
        <label>
          Heading family
          <input
            value={value.typography.heading.family}
            onChange={(e) =>
              setField('typography', {
                ...value.typography,
                heading: { ...value.typography.heading, family: e.target.value },
              })
            }
          />
        </label>
        <label>
          Body family
          <input
            value={value.typography.body.family}
            onChange={(e) =>
              setField('typography', {
                ...value.typography,
                body: { ...value.typography.body, family: e.target.value },
              })
            }
          />
        </label>
      </fieldset>

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
