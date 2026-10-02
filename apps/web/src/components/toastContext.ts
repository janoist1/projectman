import { createContext, useContext } from 'react';

export type ToastTone = 'ok' | 'error' | 'info';

/** A line under a toast's message: a card key (a link to it when `to` is given) and what is to say of it. */
export interface ToastItem {
  key: string;
  text: string;
  to?: string;
  /** A line of text only: `key` just tells the lines apart and is not shown. */
  bare?: boolean;
}

export interface ToastOptions {
  /** Lines listed under the message (PM-121). */
  items?: readonly ToastItem[];
  /** Stays until the person closes it: a result that has to be read (PM-121). */
  sticky?: boolean;
}

export interface ToastApi {
  show(message: string, tone?: ToastTone, options?: ToastOptions): void;
}

export const ToastContext = createContext<ToastApi>({ show: () => {} });

/** Short confirmations and errors; rendered by <ToastProvider>. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}
