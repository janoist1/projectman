import { useRef } from 'preact/hooks';
import type { ComponentChildren, RefObject } from 'preact';
import type { CardPlace } from './layout';
import { useDialogFocus } from './hooks';

interface DialogProps {
  label: string;
  /** Extra class: `card`, `panel`, `menu`, `welcome`, `help`. */
  kind: string;
  /** A floating place, or null: the dialog is then a bottom sheet (phone) or fixed by its class. */
  place?: CardPlace | null;
  phone?: boolean;
  /** The element that gets the focus when the dialog opens; the dialog itself when absent. */
  initialFocus?: () => HTMLElement | null;
  modal?: boolean;
  /** Lets the owner measure the dialog (the sheet's height, to reveal the pin above it). */
  rootRef?: RefObject<HTMLDivElement | null>;
  children: ComponentChildren;
}

/** A floating dialog or, on a phone, a bottom sheet. Esc is handled once, for all of them, in `App`. */
export function Dialog({ label, kind, place, phone, initialFocus, modal, rootRef, children }: DialogProps) {
  const own = useRef<HTMLDivElement>(null);
  const root = rootRef ?? own;
  useDialogFocus(root, initialFocus);
  const floating = !phone && place ? { left: `${place.left}px`, top: `${place.top}px` } : undefined;
  return (
    <div
      ref={root}
      class={`dlg ${kind}${phone ? ' sheet' : ''}${place?.aboveLauncher ? ' above' : ''}`}
      role="dialog"
      aria-modal={modal ? 'true' : undefined}
      aria-label={label}
      tabIndex={-1}
      style={floating}
    >
      {children}
    </div>
  );
}

export function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" class="x" aria-label={label} onClick={onClick}>
      <span aria-hidden="true">✕</span>
    </button>
  );
}
