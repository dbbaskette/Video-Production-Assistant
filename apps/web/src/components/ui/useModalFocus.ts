import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useModalFocus({
  open,
  dialogRef,
  initialFocusRef,
  escapeDisabled,
  onEscape,
}: {
  open: boolean;
  dialogRef: RefObject<HTMLElement>;
  initialFocusRef: RefObject<HTMLElement>;
  escapeDisabled: boolean;
  onEscape(): void;
}) {
  const onEscapeRef = useRef(onEscape);
  const escapeDisabledRef = useRef(escapeDisabled);
  onEscapeRef.current = onEscape;
  escapeDisabledRef.current = escapeDisabled;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const restoreOutside = dialogRef.current ? inertOutside(dialogRef.current) : () => undefined;
    const focusTimer = window.setTimeout(() => initialFocusRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        if (escapeDisabledRef.current) return;
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hidden && !element.closest('[hidden], [aria-hidden="true"], [inert]'));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKeyDown);
      restoreOutside();
      if (opener?.isConnected) opener.focus();
    };
  }, [dialogRef, initialFocusRef, open]);
}

function inertOutside(modal: HTMLElement): () => void {
  const changed: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
  let branch = modal;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      changed.push({
        element: sibling,
        inert: sibling.inert,
        ariaHidden: sibling.getAttribute('aria-hidden'),
      });
      sibling.inert = true;
      sibling.setAttribute('aria-hidden', 'true');
    }
    branch = parent;
  }
  return () => {
    for (const { element, inert, ariaHidden } of changed) {
      element.inert = inert;
      if (ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', ariaHidden);
    }
  };
}
