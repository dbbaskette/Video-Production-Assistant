import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * A simple collapsible group with a clickable header. The header always
 * renders a small "+ N" / "− hide" affordance and an optional secondary
 * subtitle on the right (e.g. counts / status). Children render under the
 * header when expanded.
 *
 * State is local; it does NOT persist across navigations. Pages can pass
 * `defaultOpen` to control initial state per-section.
 */
interface Props {
  title: string;
  /** Right-aligned subtitle, e.g. "3 of 5 done" or "Tanzu". */
  subtitle?: ReactNode;
  /** Whether the section opens expanded. Default true. */
  defaultOpen?: boolean;
  /** When set, this section auto-opens whenever the URL hash matches.
   *  Pass strings WITHOUT the leading "#". Comma-separated for multiple
   *  anchors (e.g. a section that hosts both #render and #export). */
  anchorHash?: string;
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = true,
  anchorHash,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const location = useLocation();

  // When the URL hash matches one of this section's anchors, force-open so
  // the deep-linked content actually renders into the DOM (children unmount
  // when collapsed, which breaks scrollIntoView on inner ids).
  useEffect(() => {
    if (!anchorHash) return;
    const target = (location.hash || '').replace(/^#/, '');
    if (!target) return;
    const wanted = anchorHash.split(',').map((s) => s.trim());
    if (wanted.includes(target)) setOpen(true);
  }, [anchorHash, location.hash, location.key]);

  return (
    <section className="collapsible-section">
      <button
        type="button"
        className="collapsible-section__trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="collapsible-section__title">
          <span
            aria-hidden
            className="collapsible-section__chevron"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            ▶
          </span>
          <span>{title}</span>
        </span>
        {subtitle != null && <span className="collapsible-section__subtitle">{subtitle}</span>}
      </button>
      {open && <div className="collapsible-section__content">{children}</div>}
    </section>
  );
}
