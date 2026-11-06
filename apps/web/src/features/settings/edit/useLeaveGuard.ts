import { useCallback, useContext, useEffect, useRef } from 'react';
import { useToast } from '../../../components/toastContext';
import { t } from '../../../i18n/t';
import { LeaveGuardContext } from './LeaveGuard';
import { useReportUnsaved } from './SettingsEditing';

/**
 * Protects an unsaved change: the selection's steps and the Back button ask first (through the
 * surrounding `LeaveGuardProvider`), closing the tab asks the browser, and leaving the settings by the
 * menu says that the change was lost. The controls that save at once wait while it is held.
 */
export function useLeaveGuard(dirty: boolean, discard: () => void, name: string) {
  const guard = useContext(LeaveGuardContext);
  useReportUnsaved(dirty);
  const toast = useToast();
  const unsaved = useRef(dirty);
  useEffect(() => {
    unsaved.current = dirty;
  }, [dirty]);
  const drop = useCallback(() => {
    // Synchronously, so the unmount that follows is not taken for a loss.
    unsaved.current = false;
    discard();
  }, [discard]);
  const register = guard?.register;
  useEffect(() => {
    if (!dirty || !register) return;
    register({ name, discard: drop });
    return () => register(null);
  }, [dirty, register, name, drop]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(
    () => () => {
      if (unsaved.current) toast.show(t('settings.pipeline.edit.lost'), 'info');
    },
    [toast],
  );
}
