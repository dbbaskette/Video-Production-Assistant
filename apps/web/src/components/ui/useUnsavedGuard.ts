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
 * The confirmation uses window.confirm — small, synchronous, no extra
 * modal-on-modal complexity. If we ever want a richer in-app prompt we
 * can swap the implementation here without touching call sites.
 */

import { useCallback } from 'react';

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
  return useCallback(() => {
    if (!hasUnsavedChanges) {
      onConfirmDiscard();
      return;
    }
    if (window.confirm(message)) {
      onConfirmDiscard();
    }
  }, [hasUnsavedChanges, message, onConfirmDiscard]);
}
