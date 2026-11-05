import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router';
import type { Location } from 'react-router';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { t } from '../../../i18n/t';

/** What the open editor tells the guard while it holds an unsaved change. */
export interface LeaveRegistration {
  /** The name of what would be lost, for the question. */
  name: string;
  discard(): void;
}

export interface LeaveGuardApi {
  register(registration: LeaveRegistration | null): void;
  /** Runs `proceed` at once, or once the person agreed to drop the unsaved change. */
  request(proceed: () => void): void;
  /** While the question about a Back or Forward step is open: the search of the address still shown. */
  heldSearch: string | null;
}

export const LeaveGuardContext = createContext<LeaveGuardApi | null>(null);

type Pending = { proceed: () => void } | { stay: Location; to: Location };

const showOf = (location: Pick<Location, 'search'>) => new URLSearchParams(location.search).get('show');

/**
 * The question "Elveted a módosítást?" for everything that would leave an editor with an unsaved change:
 * the selection's own steps ask through `request`, and a Back or Forward step that changes the selected
 * element is noticed here (the router has no blocker under a BrowserRouter), the address put back if the
 * person keeps the change.
 */
export function LeaveGuardProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const registration = useRef<LeaveRegistration | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState('');
  const settled = useRef(location);

  // Found while rendering: the editor below unmounts in this very commit, before any effect could hold it back.
  const before = settled.current;
  const stepped =
    registration.current !== null &&
    location.key !== before.key &&
    navigationType === 'POP' &&
    location.pathname === before.pathname &&
    showOf(location) !== showOf(before);
  useEffect(() => {
    if (location.key === before.key) return;
    if (stepped && registration.current) {
      setName(registration.current.name);
      setPending({ stay: before, to: location });
      return;
    }
    settled.current = location;
  }, [location, navigationType]);

  const register = useCallback((next: LeaveRegistration | null) => {
    registration.current = next;
  }, []);
  const request = useCallback((proceed: () => void) => {
    if (!registration.current) return proceed();
    setName(registration.current.name);
    setPending({ proceed });
  }, []);
  const heldSearch = pending && 'stay' in pending ? pending.stay.search : stepped ? before.search : null;
  const api = useMemo(() => ({ register, request, heldSearch }), [register, request, heldSearch]);

  const keep = () => {
    if (pending && 'stay' in pending)
      navigate(
        { pathname: pending.stay.pathname, search: pending.stay.search },
        { replace: true, state: pending.stay.state },
      );
    setPending(null);
  };
  const drop = () => {
    const current = pending;
    // The registration goes first: the step that follows must not meet the old editor again.
    const dropped = registration.current;
    registration.current = null;
    dropped?.discard();
    setPending(null);
    if (!current) return;
    if ('stay' in current) settled.current = current.to;
    else current.proceed();
  };

  return (
    <LeaveGuardContext.Provider value={api}>
      {children}
      <Dialog
        open={pending !== null}
        size="sm"
        title={t('settings.pipeline.edit.leaveTitle')}
        description={t('settings.pipeline.edit.leaveBody', { name })}
        onClose={keep}
        footer={
          <>
            <Button size="md" variant="secondary" onClick={drop}>
              {t('settings.pipeline.edit.leaveDiscard')}
            </Button>
            <Button size="md" variant="primary" autoFocus onClick={keep}>
              {t('settings.pipeline.edit.leaveKeep')}
            </Button>
          </>
        }
      />
    </LeaveGuardContext.Provider>
  );
}
