import { createContext, useContext } from 'react';

export type ToastTone = 'ok' | 'error' | 'info';

export interface ToastApi {
  show(message: string, tone?: ToastTone): void;
}

export const ToastContext = createContext<ToastApi>({ show: () => {} });

/** Short confirmations and errors; rendered by <ToastProvider>. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}
