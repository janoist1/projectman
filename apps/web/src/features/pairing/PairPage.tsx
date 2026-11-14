import { formatPairingCode, normalizePairingCode } from '@projectman/shared';
import type { PairingView } from '@projectman/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { usePairingApprove, usePairingDeny, usePairingLookup } from '../../api/queries';
import { t } from '../../i18n/t';
import { AuthLayout } from '../auth/AuthLayout';
import { formatCountdown, useCountdown, useSingleFlight } from '../auth/emailLogin';
import { ApproveView } from './ApproveView';
import type { Decision } from './ApproveView';
import { EnterCodeView } from './EnterCodeView';
import { classifyFailure, formatTypedCode } from './pairingCode';
import { DeniedView, DoneView, ExpiredView, LoadingView, NoRightView } from './ResultViews';

type Pending = Extract<PairingView, { state: 'pending' }>;
type Approved = Extract<PairingView, { state: 'approved' }>;

type Phase =
  | { kind: 'enter'; invalid: boolean; failure: unknown }
  | { kind: 'loading' }
  | { kind: 'approve'; view: Pending }
  | { kind: 'done'; view: Approved }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'noRight' };

/** The views that replace the form: the focus goes to the new title when one of them shows up. */
const TITLE_FOCUS: ReadonlyArray<Phase['kind']> = [
  'loading',
  'approve',
  'done',
  'denied',
  'expired',
  'noRight',
];

/**
 * `/pair` and `/pair/:code` (PM-1450): the owner compares the code with the one on the machine and approves or
 * denies the pairing. The code lives in this component's state only: never in the storage, the history or a path
 * the page navigates to.
 */
export function PairPage() {
  const { code: linked } = useParams();
  const navigate = useNavigate();
  const lookup = usePairingLookup();
  const approve = usePairingApprove();
  const deny = usePairingDeny();
  const flight = useSingleFlight();
  const title = useRef<HTMLHeadingElement>(null);

  const [typed, setTyped] = useState(() => (linked ? formatTypedCode(linked) : ''));
  const [phase, setPhase] = useState<Phase>(() =>
    linked ? { kind: 'loading' } : { kind: 'enter', invalid: false, failure: null },
  );
  const [running, setRunning] = useState<Decision | null>(null);
  const [failed, setFailed] = useState<{ decision: Decision } | null>(null);
  const [limitUntil, setLimitUntil] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const limitLeft = useCountdown(limitUntil);
  const waited = useRef(false);
  const runningRef = useRef(false);

  useEffect(() => {
    if (limitLeft > 0) waited.current = true;
    else if (waited.current) {
      waited.current = false;
      setAnnouncement(t('pairing.enter.announceReady'));
    }
  }, [limitLeft]);

  useEffect(() => {
    if (TITLE_FOCUS.includes(phase.kind)) title.current?.focus();
  }, [phase.kind]);

  const find = useCallback(
    (raw: string) =>
      flight(async () => {
        const code = normalizePairingCode(raw);
        if (!code) {
          setPhase({ kind: 'enter', invalid: true, failure: null });
          return;
        }
        setPhase({ kind: 'loading' });
        try {
          const view = await lookup.mutateAsync(formatPairingCode(code));
          setPhase(
            view.state === 'pending'
              ? { kind: 'approve', view }
              : view.state === 'approved'
                ? { kind: 'done', view }
                : { kind: 'denied' },
          );
        } catch (error) {
          const failure = classifyFailure(error);
          if (failure.kind === 'no_right') setPhase({ kind: 'noRight' });
          else if (failure.kind === 'invalid') setPhase({ kind: 'enter', invalid: true, failure: null });
          else if (failure.kind === 'limit') {
            setLimitUntil(Date.now() + failure.seconds * 1000);
            setAnnouncement(t('pairing.enter.tooMany', { time: formatCountdown(failure.seconds) }));
            setPhase({ kind: 'enter', invalid: false, failure: null });
          } else setPhase({ kind: 'enter', invalid: false, failure: failure.error });
        }
      }),
    [flight, lookup],
  );

  // A link carries the code: look it up once, on arrival.
  const looked = useRef(false);
  useEffect(() => {
    if (!linked || looked.current) return;
    looked.current = true;
    void find(linked);
  }, [linked, find]);

  const decide = (decision: Decision) => {
    if (phase.kind !== 'approve') return;
    const { code } = phase.view;
    void flight(async () => {
      runningRef.current = true;
      setRunning(decision);
      setFailed(null);
      try {
        const result = await (decision === 'approve' ? approve : deny).mutateAsync(code);
        if (result.state === 'approved') setPhase({ kind: 'done', view: result });
        else setPhase({ kind: 'denied' });
      } catch (error) {
        const failure = classifyFailure(error);
        if (failure.kind === 'invalid') setPhase({ kind: 'expired' });
        else if (failure.kind === 'no_right') setPhase({ kind: 'noRight' });
        else setFailed({ decision });
      } finally {
        runningRef.current = false;
        setRunning(null);
      }
    });
  };

  const onExpired = useCallback(() => {
    if (!runningRef.current)
      setPhase((current) => (current.kind === 'approve' ? { kind: 'expired' } : current));
  }, []);

  const again = () => {
    setTyped('');
    setLimitUntil(null);
    setFailed(null);
    setPhase({ kind: 'enter', invalid: false, failure: null });
    // A link's code leaves the address with it.
    if (linked) navigate('/pair', { replace: true });
  };

  const heading = headingOf(phase);
  return (
    <AuthLayout
      title={heading.title}
      subtitle={heading.subtitle}
      titleRef={title}
      announcement={announcement}
    >
      {phase.kind === 'enter' ? (
        <EnterCodeView
          value={typed}
          onChange={(value) => {
            setTyped(value);
            setPhase({ kind: 'enter', invalid: false, failure: null });
          }}
          onSubmit={() => void find(typed)}
          invalid={phase.invalid}
          failure={phase.failure}
          limitLeft={limitLeft}
        />
      ) : phase.kind === 'loading' ? (
        <LoadingView />
      ) : phase.kind === 'approve' ? (
        <ApproveView
          view={phase.view}
          running={running}
          failure={failed}
          onDecide={decide}
          onExpired={onExpired}
        />
      ) : phase.kind === 'done' ? (
        <DoneView />
      ) : phase.kind === 'denied' ? (
        <DeniedView />
      ) : phase.kind === 'expired' ? (
        <ExpiredView onAgain={again} />
      ) : (
        <NoRightView />
      )}
    </AuthLayout>
  );
}

function headingOf(phase: Phase): { title: string; subtitle: string } {
  switch (phase.kind) {
    case 'enter':
      return { title: t('pairing.enter.title'), subtitle: t('pairing.enter.subtitle') };
    case 'loading':
      return { title: t('pairing.enter.title'), subtitle: t('pairing.loading') };
    case 'approve':
      return { title: t('pairing.approve.title'), subtitle: t('pairing.approve.subtitle') };
    case 'done':
      return {
        title: t('pairing.done.title'),
        subtitle: t('pairing.done.subtitle', { name: phase.view.machineName }),
      };
    case 'denied':
      return { title: t('pairing.denied.title'), subtitle: t('pairing.denied.subtitle') };
    case 'expired':
      return { title: t('pairing.expired.title'), subtitle: t('pairing.expired.subtitle') };
    case 'noRight':
      return { title: t('pairing.noRight.title'), subtitle: t('pairing.noRight.subtitle') };
  }
}
