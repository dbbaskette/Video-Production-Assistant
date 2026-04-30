import { Link } from 'react-router-dom';
import type { BrandRegistryEntry } from '@vpa/shared';

interface Props {
  entry: BrandRegistryEntry;
  swatch?: string;
  isDefault: boolean;
}

export function BrandCard({ entry, swatch, isDefault }: Props) {
  const isFork = entry.forked_from !== null;
  return (
    <Link to={`/brands/${entry.id}`} className="brand-card">
      <span
        className="brand-card__swatch"
        style={{ background: swatch ?? '#334155' }}
      />
      <span className="brand-card__name">{entry.name}</span>
      {isDefault && <span className="brand-card__badge" title="Default brand">Default</span>}
      {isFork && <span className="brand-card__badge brand-card__badge--fork" title={`fork of ${entry.forked_from}`}>Fork</span>}
    </Link>
  );
}
