/**
 * UiProvider — single source for in-app toasts, confirm dialogs, and
 * prompt dialogs. Replaces every `window.alert / confirm / prompt` so the
 * dark theme stays intact and we get proper validation, async returns,
 * and a-11y-friendly focus management.
 *
 * Usage:
 *   const { showToast, confirm, prompt: ask } = useUi();
 *   showToast({ message: 'Saved', tone: 'success' });
 *   if (await confirm({ title: 'Delete?', destructive: true })) ...
 *   const name = await ask({ title: 'Fork name', placeholder: '...' });
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// ── Public API ───────────────────────────────────────────────────────

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

export interface ToastInput {
  message: string;
  tone?: ToastTone;
  /** Auto-dismiss delay in ms. 0 = sticky. Default 4500. */
  durationMs?: number;
  /** Optional secondary text under the message. */
  detail?: string;
}

export interface ConfirmInput {
  title: string;
  body?: string;
  /** Label on the primary button. Default "Confirm". */
  confirmLabel?: string;
  /** Label on the cancel button. Default "Cancel". */
  cancelLabel?: string;
  /** Render the primary button as the danger style. */
  destructive?: boolean;
}

export interface PromptInput {
  title: string;
  body?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Optional validator. Return null when valid, or an error message string. */
  validate?: (value: string) => string | null;
}

export interface UiApi {
  showToast: (input: ToastInput) => void;
  confirm: (input: ConfirmInput) => Promise<boolean>;
  prompt: (input: PromptInput) => Promise<string | null>;
}

// ── Internal state shapes ────────────────────────────────────────────

interface ToastEntry extends ToastInput {
  id: string;
}

type DialogState =
  | { kind: 'confirm'; input: ConfirmInput; resolve: (result: boolean) => void }
  | { kind: 'prompt'; input: PromptInput; resolve: (result: string | null) => void }
  | null;

const UiContext = createContext<UiApi | null>(null);

// ── Provider ─────────────────────────────────────────────────────────

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const idCounter = useRef(0);

  const showToast = useCallback((input: ToastInput) => {
    const id = `t-${++idCounter.current}`;
    const entry: ToastEntry = { ...input, id };
    setToasts((prev) => [...prev, entry]);
    const ms = input.durationMs ?? 4500;
    if (ms > 0) {
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, ms);
    }
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const confirm = useCallback(
    (input: ConfirmInput) =>
      new Promise<boolean>((resolve) => setDialog({ kind: 'confirm', input, resolve })),
    [],
  );

  const ask = useCallback(
    (input: PromptInput) =>
      new Promise<string | null>((resolve) => setDialog({ kind: 'prompt', input, resolve })),
    [],
  );

  const closeDialog = useCallback((result: boolean | string | null) => {
    setDialog((current) => {
      if (!current) return null;
      // The two resolver shapes differ; route by kind so TypeScript is happy.
      if (current.kind === 'confirm') current.resolve(result === true);
      else current.resolve(typeof result === 'string' ? result : null);
      return null;
    });
  }, []);

  const api = useMemo<UiApi>(
    () => ({ showToast, confirm, prompt: ask }),
    [showToast, confirm, ask],
  );

  return (
    <UiContext.Provider value={api}>
      {children}
      <ToastTray toasts={toasts} onDismiss={dismissToast} />
      {dialog && <DialogShell state={dialog} onClose={closeDialog} />}
    </UiContext.Provider>
  );
}

export function useUi(): UiApi {
  const ctx = useContext(UiContext);
  if (!ctx) {
    throw new Error('useUi() called outside <UiProvider>. Wrap your app root.');
  }
  return ctx;
}

// ── Toast tray ───────────────────────────────────────────────────────

function ToastTray({
  toasts,
  onDismiss,
}: {
  toasts: ToastEntry[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 1000,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />)}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastEntry; onDismiss: (id: string) => void }) {
  const tone = toast.tone ?? 'info';
  const { borderColor, fgColor } = TONE_STYLES[tone];
  return (
    <div
      role="status"
      style={{
        pointerEvents: 'auto',
        background: 'var(--bg-elev)',
        border: `1px solid ${borderColor}`,
        borderLeft: `3px solid ${borderColor}`,
        borderRadius: 8,
        padding: '12px 14px',
        minWidth: 280,
        maxWidth: 420,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: fgColor }}>{toast.message}</div>
        {toast.detail && (
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4, wordBreak: 'break-word' }}>
            {toast.detail}
          </div>
        )}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          padding: 0,
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

const TONE_STYLES: Record<ToastTone, { borderColor: string; fgColor: string }> = {
  info: { borderColor: 'var(--accent)', fgColor: 'var(--fg)' },
  success: { borderColor: 'var(--success)', fgColor: 'var(--fg)' },
  warn: { borderColor: 'var(--warn)', fgColor: 'var(--fg)' },
  error: { borderColor: 'var(--danger)', fgColor: 'var(--fg)' },
};

// ── Dialog shell (confirm + prompt) ──────────────────────────────────

function DialogShell({
  state,
  onClose,
}: {
  state: NonNullable<DialogState>;
  onClose: (result: boolean | string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(
    state.kind === 'prompt' ? (state.input.defaultValue ?? '') : '',
  );
  const [error, setError] = useState<string | null>(null);

  // Focus the right element on mount + handle Escape
  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(state.kind === 'confirm' ? false : null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, state.kind]);

  const handleConfirm = () => {
    if (state.kind === 'prompt') {
      const trimmed = value.trim();
      if (state.input.validate) {
        const err = state.input.validate(trimmed);
        if (err) {
          setError(err);
          return;
        }
      }
      onClose(trimmed);
    } else {
      onClose(true);
    }
  };

  const isPrompt = state.kind === 'prompt';
  const input = state.input;
  const destructive = state.kind === 'confirm' && state.input.destructive;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={input.title}
      onClick={() => onClose(isPrompt ? null : false)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
          width: 'min(440px, 90vw)',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>{input.title}</h2>
        {input.body && (
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '8px 0 16px', whiteSpace: 'pre-wrap' }}>
            {input.body}
          </p>
        )}

        {isPrompt && (
          <>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
              placeholder={state.input.placeholder}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: 'var(--bg-elev)',
                color: 'var(--fg)',
                border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
                borderRadius: 6,
                fontSize: 14,
                marginTop: input.body ? 0 : 12,
              }}
            />
            {error && (
              <p style={{ fontSize: 12, color: 'var(--danger)', margin: '6px 0 0' }}>{error}</p>
            )}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button
            onClick={() => onClose(isPrompt ? null : false)}
            style={{ padding: '8px 16px', fontSize: 13 }}
          >
            {input.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={!isPrompt ? (inputRef as unknown as React.RefObject<HTMLButtonElement>) : undefined}
            onClick={handleConfirm}
            className={destructive ? 'btn--danger' : 'primary'}
            style={{ padding: '8px 16px', fontSize: 13 }}
          >
            {input.confirmLabel ?? (destructive ? 'Delete' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
