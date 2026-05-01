import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { DesignMdFrontMatter, TypographyLevel } from '@vpa/shared';

interface Props {
  value: DesignMdFrontMatter;
  body?: string;
}

function resolve(
  value: string,
  colors: Record<string, string>,
): string {
  return value.replace(/\{colors\.([a-zA-Z0-9_-]+)\}/g, (_, key) => {
    return (colors as Record<string, string>)[key] ?? value;
  });
}

function contrastColor(hex: string): string {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

function quickYaml(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return `${pad}null`;
  if (typeof obj === 'string') return `${pad}${obj}`;
  if (typeof obj === 'number' || typeof obj === 'boolean')
    return `${pad}${String(obj)}`;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return `${pad}[]`;
    return obj.map((v) => `${pad}- ${typeof v === 'object' && v !== null ? '\n' + quickYaml(v, indent + 2) : String(v)}`).join('\n');
  }
  if (typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>)
      .map(([k, v]) => {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          return `${pad}${k}:\n${quickYaml(v, indent + 1)}`;
        }
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${k}: []`;
          return `${pad}${k}:\n${quickYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${v === null ? 'null' : String(v)}`;
      })
      .join('\n');
  }
  return `${pad}${String(obj)}`;
}

/** Find the first typography level matching a pattern, or fall back */
function findLevel(
  typography: Record<string, TypographyLevel>,
  ...patterns: string[]
): TypographyLevel | undefined {
  for (const pattern of patterns) {
    const found = Object.entries(typography).find(([k]) =>
      k.toLowerCase().includes(pattern),
    );
    if (found) return found[1];
  }
  // Fall back to the first level
  const entries = Object.values(typography);
  return entries[0];
}

export function BrandPreviewPane({ value, body }: Props) {
  const [tab, setTab] = useState<'visual' | 'markdown'>('visual');

  const colorEntries = Object.entries(value.colors);
  const typography = value.typography as Record<string, TypographyLevel>;
  const vpa = value.vpa;

  const headlineLevel = findLevel(typography, 'headline', 'h1', 'display');
  const bodyLevel = findLevel(typography, 'body', 'paragraph', 'text');

  const colors = value.colors as Record<string, string>;
  const neutralColor = colors['neutral'] ?? colors['surface'] ?? '#FFFFFF';
  const onSurfaceColor = colors['on-surface'] ?? colors['on_surface'] ?? '#000000';

  const lowerBg = vpa
    ? resolve(vpa.lower_thirds.bg, colors)
    : colors.primary;
  const lowerFg = vpa
    ? resolve(vpa.lower_thirds.fg, colors)
    : neutralColor;

  const fullSource = `---\n${quickYaml(value)}\n---\n\n${body ?? ''}`;

  return (
    <div className="preview-pane">
      <div className="preview-tabs">
        <button
          className={tab === 'visual' ? 'active' : ''}
          onClick={() => setTab('visual')}
        >
          Visual
        </button>
        <button
          className={tab === 'markdown' ? 'active' : ''}
          onClick={() => setTab('markdown')}
        >
          Markdown
        </button>
      </div>

      <div className="preview-body">
        {tab === 'visual' ? (
          <>
            {/* Color palette */}
            <div className="palette">
              {colorEntries.map(([key, hex]) => (
                <div
                  key={key}
                  className="palette-cell"
                  style={{
                    background: hex as string,
                    color: contrastColor(hex as string),
                  }}
                >
                  {key}
                </div>
              ))}
            </div>

            {/* Type sample */}
            <div
              className="type-sample"
              style={{
                background: neutralColor,
                color: onSurfaceColor,
              }}
            >
              <h3
                style={{
                  fontFamily: headlineLevel?.fontFamily ?? 'inherit',
                  fontSize: headlineLevel?.fontSize ?? '28px',
                  fontWeight: headlineLevel?.fontWeight ?? 700,
                  margin: '0 0 6px',
                }}
              >
                {value.name}
              </h3>
              <p
                style={{
                  fontFamily: bodyLevel?.fontFamily ?? 'inherit',
                  fontSize: bodyLevel?.fontSize ?? '16px',
                  fontWeight: bodyLevel?.fontWeight ?? 400,
                  margin: 0,
                }}
              >
                The quick brown fox jumps over the lazy dog. Brand typography
                preview using {bodyLevel?.fontFamily ?? 'default'} for body text.
              </p>
            </div>

            {/* Lower third mock */}
            <div className="lower-third-mock">
              <div
                className="lower-third-bar"
                style={{
                  background: lowerBg,
                  color: lowerFg,
                  borderColor: colors.secondary ?? colors.primary,
                }}
              >
                <strong style={{ fontSize: 14 }}>{value.name}</strong>
                <span style={{ fontSize: 11, opacity: 0.8 }}>
                  {value.description ?? 'Brand subtitle'}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="design-md-source">
            <ReactMarkdown>{fullSource}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
