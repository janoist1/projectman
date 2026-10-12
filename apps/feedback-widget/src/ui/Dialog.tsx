import { useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
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
  children: ComponentChildren;
}

/** A floating dialog or, on a phone, a bottom sheet. Esc is handled once, for all of them, in `App`. */
export function Dialog({ label, kind, place, phone, initialFocus, modal, children }: DialogProps) {
  const root = useRef<HTMLDivElement>(null);
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
