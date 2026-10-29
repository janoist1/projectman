import { useEffect, useState } from 'react';
import type { CreateEngineResponse, EngineView } from '@projectman/shared';
import { useCreateEngine, useRevokeEngine, useServerVersion } from '../../api/queries';
import { Button, ButtonLink } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Fold } from '../../components/Fold';
import { SegmentedControl } from '../../components/SegmentedControl';
import { t } from '../../i18n/t';
import { errorCode, errorMessage } from '../../lib/errors';
import { CopyRow } from '../engines/CopyRow';
import { EngineModeSwitch } from '../engines/EngineModeSwitch';
import {
  DEPLOY_DOCS_URL,
  ENGINE_APP_SHIM_PATH,
  LINK_HEADERS_FILE,
  LINK_HEADERS_SAMPLE,
  engineInitCommand,
  engineInstallCommand,
  engineServiceInstall,
  engineServiceStatus,
  machineParts,
} from '../engines/engineView';
import type { EngineMode } from '../engines/engineView';
import { useEngineAppDownload, useEngineMode } from '../engines/useEngineMode';
import type { EngineAppDownload } from '../engines/useEngineMode';
import styles from './OwnerOnboarding.module.css';

const DOCS_URL = 'https://github.com/janoist1/projectman/blob/main/docs/HYBRID.md';
/** The "Nem jelentkezik?" help opens by itself when the machine has not reported for this long. */
const STUCK_MS = 3 * 60_000;

type Tab = 'assistant' | 'manual';

/** The text for the owner's own assistant. It names no key and no access value: the assistant asks for them. */
export function assistantInstruction(
  engine: Pick<EngineView, 'id' | 'name'>,
  ref: string | null,
  mode: EngineMode,
  download: EngineAppDownload,
): string {
  const common = {
    origin: window.location.origin,
    file: LINK_HEADERS_FILE,
    sample: LINK_HEADERS_SAMPLE,
    init: engineInitCommand(engine, mode),
    status: engineServiceStatus(mode),
  };
  if (mode === 'app') {
    return t('ownerOnboarding.guide.assistantInstructionApp', {
      ...common,
      shim: ENGINE_APP_SHIM_PATH,
      download:
        download.state === 'ready'
          ? download.url
          : t('ownerOnboarding.guide.assistantDownloadDocs', { url: DEPLOY_DOCS_URL }),
    });
  }
  return t('ownerOnboarding.guide.assistantInstruction', {
    ...common,
    install: engineInstallCommand(ref),
    service: engineServiceInstall(mode),
  });
}

/** Step 1 of the app's manual install: the download button, or why there is none. */
function AppDownloadStep({ download }: { download: EngineAppDownload }) {
  const none = download.state === 'none';
  return (
    <>
      <p className={styles.sub}>
        {t(none ? 'ownerOnboarding.guide.appNoRelease' : 'ownerOnboarding.guide.appDownload')}
      </p>
      {download.state === 'ready' ? (
        <ButtonLink
          to={download.url}
          download
          variant="secondary"
          size="md"
          icon="download"
          aria-label={t('ownerOnboarding.guide.appDownloadAria')}
        >
          {t('ownerOnboarding.guide.appDownloadButton')}
        </ButtonLink>
      ) : download.state === 'loading' ? (
        <Button variant="secondary" size="md" icon="download" aria-disabled="true">
          {t('ownerOnboarding.guide.appDownloadButton')}
        </Button>
      ) : null}
      {none ? (
        <p className={styles.hint}>
          {t('ownerOnboarding.guide.appNoReleaseBody')}{' '}
          <a href={DEPLOY_DOCS_URL} target="_blank" rel="noreferrer">
            {t('ownerOnboarding.guide.appNoReleaseLink')}
          </a>
        </p>
      ) : (
        <p className={styles.hint}>{t('ownerOnboarding.guide.appDownloadHint')}</p>
      )}
    </>
  );
}

/**
 * How to set up a new machine: with the owner's assistant or by hand, with the machine key shown once and the
 * machine's live state under it. `secret` is null after a reload; only "Új kulcs" is left then.
 */
export function EngineSetupGuide({
  engine,
  secret,
  onKeyIssued,
  pollFailed = false,
}: {
  engine: EngineView;
  secret: string | null;
  onKeyIssued: (created: CreateEngineResponse) => void;
  /** The list of machines could not be read; the live state says so instead of waiting silently. */
  pollFailed?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('assistant');
  const [mode] = useEngineMode();
  const download = useEngineAppDownload();
  const [renewing, setRenewing] = useState(false);
  const [stuckOpen, setStuckOpen] = useState(false);
  const version = useServerVersion(true);
  const ref = version.data ? (version.data.tag ?? version.data.commit) : null;
  useEffect(() => {
    const timer = window.setTimeout(() => setStuckOpen(true), STUCK_MS);
    return () => window.clearTimeout(timer);
  }, [engine.id]);
  return (
    <div className={styles.stepBody}>
      <EngineModeSwitch />
      <SegmentedControl
        className={styles.tabs}
        label={t('ownerOnboarding.guide.tabsLabel')}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'assistant', label: t('ownerOnboarding.guide.tabAssistant') },
          { value: 'manual', label: t('ownerOnboarding.guide.tabManual') },
        ]}
      />
      {secret ? (
        <>
          <p className={styles.warn} role="note">
            <strong>{t('ownerOnboarding.guide.keyOnceStrong')}</strong>{' '}
            {t('ownerOnboarding.guide.keyOnceBody')}
          </p>
          <CopyRow text={secret} label={t('ownerOnboarding.guide.keyAria')} />
        </>
      ) : (
        <p className={styles.hint}>{t('ownerOnboarding.guide.keyGone')}</p>
      )}
      {tab === 'assistant' ? (
        <>
          <p className={styles.sub}>{t('ownerOnboarding.guide.assistantStep')}</p>
          <CopyRow
            scroll
            text={assistantInstruction(engine, ref, mode, download)}
            label={t('ownerOnboarding.guide.assistantAria')}
          />
          <p className={styles.hint}>{t('ownerOnboarding.guide.assistantHelp')}</p>
        </>
      ) : (
        <div className={styles.commands}>
          {mode === 'app' ? (
            <AppDownloadStep download={download} />
          ) : (
            <>
              <p className={styles.sub}>{t('ownerOnboarding.guide.manualInstall')}</p>
              <CopyRow
                text={engineInstallCommand(ref)}
                label={t('ownerOnboarding.guide.manualInstallAria')}
              />
            </>
          )}
          <p className={styles.sub}>{t('ownerOnboarding.guide.manualToken')}</p>
          <CopyRow text={LINK_HEADERS_FILE} label={t('ownerOnboarding.guide.manualTokenAria')} />
          <p className={styles.hint}>
            {t('ownerOnboarding.guide.manualTokenHint', { sample: LINK_HEADERS_SAMPLE })}
          </p>
          <p className={styles.sub}>{t('ownerOnboarding.guide.manualInit')}</p>
          <CopyRow text={engineInitCommand(engine, mode)} label={t('ownerOnboarding.guide.manualInitAria')} />
          {mode === 'app' ? (
            <>
              <p className={styles.sub}>{t('ownerOnboarding.guide.appService')}</p>
              <p className={styles.hint}>{t('ownerOnboarding.guide.appServiceHint')}</p>
            </>
          ) : (
            <>
              <p className={styles.sub}>{t('ownerOnboarding.guide.manualService')}</p>
              <CopyRow
                text={engineServiceInstall(mode)}
                label={t('ownerOnboarding.guide.manualServiceAria')}
              />
              <p className={styles.hint}>
                {t('ownerOnboarding.guide.manualLinux', { command: 'npm run engine -- start' })}
              </p>
            </>
          )}
        </div>
      )}
      <p className={styles.hint}>
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          {t('ownerOnboarding.guide.details')}
        </a>
        {' · '}
        <button type="button" className={styles.linkButton} onClick={() => setRenewing(true)}>
          {t('ownerOnboarding.guide.newKey')}
        </button>
      </p>
      <EngineLiveStatus engine={engine} failed={pollFailed} />
      <Fold summary={t('ownerOnboarding.guide.stuckSummary')} open={stuckOpen} onToggle={setStuckOpen}>
        <ul className={styles.stuck}>
          <li>{t('ownerOnboarding.guide.stuckKey')}</li>
          <li>{t('ownerOnboarding.guide.stuckToken')}</li>
          <li>{t('ownerOnboarding.guide.stuckService', { command: engineServiceStatus(mode) })}</li>
        </ul>
      </Fold>
      {renewing ? (
        <NewKeyDialog engine={engine} onClose={() => setRenewing(false)} onIssued={onKeyIssued} />
      ) : null}
    </div>
  );
}

/** The machine's state, read aloud when it changes: waiting for it, or connected with what it reported. */
export function EngineLiveStatus({ engine, failed = false }: { engine: EngineView; failed?: boolean }) {
  if (engine.online) {
    const parts = machineParts(engine);
    return (
      <div className={styles.live} data-state="ok" role="status">
        <span className={styles.liveDot} aria-hidden="true" />
        <span>
          <strong>{t('ownerOnboarding.guide.connected', { name: engine.name })}</strong>{' '}
          {parts.map((part) => part.text).join(t('engines.workJoin'))}
          {engine.versionMismatch ? <span className={styles.hint}> {t('engines.mismatchHint')}</span> : null}
        </span>
      </div>
    );
  }
  return (
    <div className={styles.live} data-state={failed ? 'error' : 'waiting'} role="status">
      <span className={styles.liveDot} aria-hidden="true" />
      <span>{t(failed ? 'ownerOnboarding.welcome.loadFailed' : 'ownerOnboarding.guide.waiting')}</span>
    </div>
  );
}

/** "Elveszett a kulcs?": the old machine key is revoked and a new one of the same name is issued, shown once. */
function NewKeyDialog({
  engine,
  onClose,
  onIssued,
}: {
  engine: EngineView;
  onClose: () => void;
  onIssued: (created: CreateEngineResponse) => void;
}) {
  const revoke = useRevokeEngine();
  const create = useCreateEngine();
  const busy = revoke.isPending || create.isPending;
  const run = async () => {
    try {
      await revoke.mutateAsync(engine.id);
    } catch (error) {
      // A revoked or missing machine only means the list on screen was out of date; the new key is still wanted.
      const code = errorCode(error);
      if (code !== 'engine_revoked' && code !== 'engine_not_found') return;
    }
    create.mutate({ name: engine.name, onCreated: onIssued });
  };
  const failure = create.isError ? create.error : revoke.isError ? revoke.error : null;
  return (
    <Dialog
      open
      size="sm"
      title={t('ownerOnboarding.guide.newKeyTitle', { name: engine.name })}
      description={t('ownerOnboarding.guide.newKeyBody')}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="md" loading={busy} onClick={() => void run()}>
            {t('ownerOnboarding.guide.newKeyConfirm')}
          </Button>
        </>
      }
      error={failure ? <ErrorBanner>{errorMessage(failure)}</ErrorBanner> : undefined}
    />
  );
}
