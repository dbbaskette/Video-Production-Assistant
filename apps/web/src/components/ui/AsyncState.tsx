import { AlertCircle, LoaderCircle, RotateCcw } from 'lucide-react';

export function LoadingState({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="async-state async-state--loading" role="status" aria-label={label} aria-live="polite">
      <LoaderCircle className="spin" size={18} aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        {detail && <span>{detail}</span>}
      </div>
    </div>
  );
}

export function LoadError({
  title,
  detail,
  onRetry,
  retrying = false,
}: {
  title: string;
  detail?: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="async-state async-state--error" role="alert">
      <AlertCircle size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
      </div>
      <button type="button" onClick={onRetry} disabled={retrying}>
        <RotateCcw size={13} aria-hidden="true" />
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}
