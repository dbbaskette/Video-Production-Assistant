import { hex as contrastRatio } from 'wcag-contrast';
import { DesignMd, DesignMdFrontMatter } from '@vpa/shared';

export const BRAND_OK = 'ok' as const;
export type ValidationStatus = typeof BRAND_OK | 'invalid';

export interface BrandValidationIssue {
  code: string;
  message: string;
  field?: string;
  ratio?: number;
}

export interface BrandValidationResult {
  status: ValidationStatus;
  errors: BrandValidationIssue[];
  warnings: BrandValidationIssue[];
}

const AA_NORMAL = 4.5;

export function validateBrand(doc: DesignMd): BrandValidationResult {
  const errors: BrandValidationIssue[] = [];
  const warnings: BrandValidationIssue[] = [];

  const parsed = DesignMdFrontMatter.safeParse(doc.frontMatter);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ code: 'schema', message: issue.message, field: issue.path.join('.') });
    }
    return { status: 'invalid', errors, warnings };
  }
  const fm = parsed.data;

  const baseRatio = contrastRatio(fm.colors.on_surface, fm.colors.surface);
  if (baseRatio < AA_NORMAL) {
    warnings.push({
      code: 'low-contrast',
      message: `on_surface on surface fails WCAG AA (${baseRatio.toFixed(2)}:1, target ${AA_NORMAL}:1)`,
      field: 'colors.on_surface',
      ratio: baseRatio,
    });
  }

  if (fm.vpa) {
    const fg = resolveColor(fm.vpa.lower_thirds.fg, fm.colors as Record<string, string>);
    const bg = resolveColor(fm.vpa.lower_thirds.bg, fm.colors as Record<string, string>);
    if (fg && bg) {
      const ratio = contrastRatio(fg, bg);
      if (ratio < AA_NORMAL) {
        warnings.push({
          code: 'low-contrast',
          message: `lower_thirds fg on bg fails WCAG AA (${ratio.toFixed(2)}:1, target ${AA_NORMAL}:1)`,
          field: 'vpa.lower_thirds.fg',
          ratio,
        });
      }
    }
  }

  return { status: BRAND_OK, errors, warnings };
}

function resolveColor(value: string, colors: Record<string, string>): string | null {
  const ref = value.match(/^\{colors\.([a-z_]+)\}$/);
  if (ref && ref[1]) return colors[ref[1]] ?? null;
  if (/^#[0-9A-Fa-f]{6,8}$/.test(value)) return value;
  return null;
}
