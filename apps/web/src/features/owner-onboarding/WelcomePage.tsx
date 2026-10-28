import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { AgentProvider } from '@projectman/shared';
import type { CreateEngineResponse, EngineView, ProviderLoginStatus } from '@projectman/shared';
import {
  useCreateEngine,
  useEngineProviders,
  useEngines,
  useMe,
  useRecheckEngineProviders,
} from '../../api/queries';
import { Button, ButtonLink } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from '../auth/AuthLayout';
import { machineParts } from '../engines/engineView';
import { ProviderTodo, providerStatusText } from '../settings/ProviderStatus';
import { EngineLiveStatus, EngineSetupGuide } from './EngineSetupGuide';
import { currentEngine, pmProvider, welcomeStep } from './welcomeState';
import type { WelcomeStep } from './welcomeState';
import styles from './OwnerOnboarding.module.css';

/** The owner's machine is not pushed to this page (a project-less account gets no events): it asks again. */
const POLL_MS = 5000;

/**
 * Első lépések: the machine, its connection, the provider login and the first project. Every step follows
 * the server's state (the machines and their logins), so a reload continues where the owner left off. Only the
 * machine key lives in this component's state, shown once.
 */
export function WelcomePage() {
  useDocumentTitle(t('ownerOnboarding.welcome.stepsLabel'));
  const me = useMe();
  const engines = useEngines(true, POLL_MS);
  const [issued, setIssued] = useState<CreateEngineResponse | null>(null);
  const engine = currentEngine(engines.data ?? []);
  const providers = useEngineProviders(engine?.online ? engine.id : null);
  const logins = providers.data?.providers ?? null;
  const step = welcomeStep(engine, logins);
  return (
    <AuthLayout
      wide
      title={t('ownerOnboarding.welcome.title', { name: me.data?.name ?? '' })}
      subtitle={t('ownerOnboarding.welcome.subtitle')}
    >
      {engines.isPending ? (
        <LoadingState />
      ) : engines.data === undefined ? (
        <ErrorState error={engines.error} onRetry={() => void engines.refetch()} />
      ) : (
        <div className={styles.card}>
          <ol className={styles.steps} aria-label={t('ownerOnboarding.welcome.stepsLabel')}>
            {([1, 2, 3, 4] as const).map((n) => (
              <Step key={n} n={n} current={step} done={engine ? doneText(n, engine, logins) : ''}>
                {n === 1 ? <NameStep onCreated={setIssued} /> : null}
                {n === 2 && engine ? (
                  <EngineSetupGuide
                    key={engine.id}
                    engine={engine}
                    secret={issued?.engine.id === engine.id ? issued.key : null}
                    onKeyIssued={setIssued}
                    pollFailed={engines.isError}
                  />
                ) : null}
                {n === 3 && engine ? (
                  <ProviderStep engine={engine} logins={logins} failed={providers.isError} />
                ) : null}
                {n === 4 && engine ? <FirstProjectStep engine={engine} /> : null}
              </Step>
            ))}
          </ol>
        </div>
      )}
    </AuthLayout>
  );
}

const TITLES = {
  1: 'ownerOnboarding.welcome.step1',
  2: 'ownerOnboarding.welcome.step2',
  3: 'ownerOnboarding.welcome.step3',
  4: 'ownerOnboarding.welcome.step4',
} as const;

/** The line a finished step closes on. */
function doneText(n: WelcomeStep, engine: EngineView, logins: readonly ProviderLoginStatus[] | null): string {
  if (n === 1) return t('ownerOnboarding.welcome.step1Done', { name: engine.name });
  if (n === 2)
    return t('ownerOnboarding.welcome.step2Done', {
      machine: machineParts(engine)
        .map((part) => part.text)
        .join(t('engines.workJoin')),
    });
  if (n === 3 && logins)
    return t('ownerOnboarding.welcome.step3Done', { provider: t(`providers.${pmProvider(logins)}`) });
  return '';
}

/** Only the current step is open; a finished one closes on one line. */
function Step({
  n,
  current,
  done,
  children,
}: {
  n: WelcomeStep;
  current: WelcomeStep;
  done: string;
  children: ReactNode;
}) {
  const state = n < current ? 'done' : n === current ? 'current' : 'todo';
  return (
    <li className={styles.step} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
      <span className={styles.num} data-state={state} aria-hidden="true">
        {state === 'done' ? <Icon name="check" size={14} strokeWidth={3} /> : n}
      </span>
      <div className={styles.stepBody}>
        <p className={styles.stepTitle}>{t(TITLES[n])}</p>
        {state === 'done' && done ? <p className={styles.line}>{done}</p> : null}
        {state === 'current' ? children : null}
      </div>
    </li>
  );
}

/** Step 1: the machine's name; creating it issues the machine key, handed on and shown once. */
function NameStep({ onCreated }: { onCreated: (created: CreateEngineResponse) => void }) {
  const create = useCreateEngine();
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || create.isPending) return;
    create.mutate({ name: trimmed, onCreated });
  };
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <TextField
        label={t('ownerOnboarding.welcome.nameLabel')}
        hint={t('ownerOnboarding.welcome.nameHint')}
        placeholder={t('ownerOnboarding.welcome.namePlaceholder')}
        maxLength={64}
        autoFocus
        value={name}
        disabled={create.isPending}
        onChange={(event) => setName(event.target.value)}
      />
      {create.isError ? <ErrorBanner>{errorMessage(create.error)}</ErrorBanner> : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" size="md" loading={create.isPending} disabled={!trimmed}>
          {t(create.isPending ? 'ownerOnboarding.welcome.creatingKey' : 'ownerOnboarding.welcome.createKey')}
        </Button>
      </div>
    </form>
  );
}

/** Step 3: what the machine reported about its AI tools; the login is done on the machine, never here. */
function ProviderStep({
  engine,
  logins,
  failed,
}: {
  engine: EngineView;
  logins: readonly ProviderLoginStatus[] | null;
  failed: boolean;
}) {
  const recheck = useRecheckEngineProviders(engine.id);
  const used = pmProvider(logins ?? []);
  return (
    <>
      <EngineLiveStatus engine={engine} />
      <p className={styles.line}>{t('ownerOnboarding.welcome.providersIntro')}</p>
      {logins === null ? (
        failed ? (
          <p className={styles.warn}>{t('ownerOnboarding.welcome.providersFailed')}</p>
        ) : (
          <LoadingState compact />
        )
      ) : (
        <div className={styles.providers}>
          {AgentProvider.options.map((provider) => {
            const entry = logins.find((row) => row.provider === provider);
            if (!entry) return null;
            const optionalMissing = provider !== used && entry.problem === 'cli_missing';
            return (
              <div key={provider} className={styles.providerRow}>
                <strong className={styles.providerName}>{t(`providers.${provider}`)}</strong>
                {provider === used ? (
                  <span className={styles.chip}>{t('ownerOnboarding.welcome.pmUses')}</span>
                ) : null}
                <span
                  className={styles.providerState}
                  data-tone={entry.loggedIn === false ? 'needs' : undefined}
                >
                  {optionalMissing
                    ? t('ownerOnboarding.welcome.optionalMissing')
                    : providerStatusText(provider, entry)}
                </span>
                {entry.loggedIn === false && !optionalMissing ? (
                  <span className={styles.providerTodo}>
                    <ProviderTodo provider={provider} entry={entry} canManageKeys={false} />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {recheck.isError ? <ErrorBanner>{errorMessage(recheck.error)}</ErrorBanner> : null}
      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="md"
          icon="refresh"
          loading={recheck.isPending}
          onClick={() => recheck.mutate()}
        >
          {t(recheck.isPending ? 'ownerOnboarding.welcome.rechecking' : 'ownerOnboarding.welcome.recheck')}
        </Button>
      </div>
    </>
  );
}

/** Step 4: everything the machine needs is there; the wizard opens with this machine chosen. */
function FirstProjectStep({ engine }: { engine: EngineView }) {
  return (
    <>
      <p className={styles.line}>{t('ownerOnboarding.welcome.allReady', { name: engine.name })}</p>
      <div className={styles.actions}>
        <ButtonLink to={`/projects/new?engine=${encodeURIComponent(engine.id)}`} variant="primary" size="md">
          {t('ownerOnboarding.welcome.createProject')}
        </ButtonLink>
      </div>
    </>
  );
}
