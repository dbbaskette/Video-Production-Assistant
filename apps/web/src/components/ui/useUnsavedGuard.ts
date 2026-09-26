/**
 * useUnsavedGuard — protects modal dialogs from a misclick on the overlay
 * (or an accidental Cancel) when the user has typed something they don't
 * want to lose.
 *
 * Usage in a dialog:
 *   const guardedClose = useUnsavedGuard({
 *     hasUnsavedChanges: name.length > 0 || objective.length > 0 || pendingDocs.length > 0,
 *     message: 'Discard typed project info?',
 *     onConfirmDiscard: onClose,
 *   });
 *   ...
 *   <div className="dialog-overlay" onClick={guardedClose}> ... </div>
 *   <button onClick={guardedClose}>Cancel</button>
 *
 * If `hasUnsavedChanges` is false, the guard is a no-op pass-through —
 * exactly equivalent to calling `onClose` directly. This keeps the
 * dialog snappy when there's nothing to lose.
 *
 * Confirmation is presented by the shared in-app dialog layer so it follows
 * the same theme, stacking, focus-trap, and keyboard behavior as other VPA
 * recovery prompts.
 */

import { useCallback, useRef } from 'react';
import { useUi } from './UiProvider.js';

interface Options {
  hasUnsavedChanges: boolean;
  /** Confirm prompt copy. Default: "Discard unsaved changes?". */
  message?: string;
  /** What "discard" actually does — usually the dialog's onClose. */
  onConfirmDiscard: () => void;
}

export function useUnsavedGuard({
  hasUnsavedChanges,
  message = 'Discard unsaved changes?',
  onConfirmDiscard,
}: Options): () => void {
  const ui = useUi();
  const confirmingRef = useRef(false);

  return useCallback(() => {
    if (!hasUnsavedChanges) {
      onConfirmDiscard();
      return;
    }
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    void ui.confirm({
      title: 'Discard unsaved changes?',
      body: message,
      confirmLabel: 'Discard',
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) onConfirmDiscard();
    }).finally(() => {
      confirmingRef.current = false;
    });
  }, [hasUnsavedChanges, message, onConfirmDiscard, ui]);
}
