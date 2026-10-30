import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useMe, useProjectEngines } from '../../api/queries';
import { ButtonLink } from '../../components/Button';
import { TextField } from '../../components/Field';
import { Fold } from '../../components/Fold';
import { ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from '../auth/AuthLayout';
import { CopyRow } from '../engines/CopyRow';
import { EngineModeSwitch } from '../engines/EngineModeSwitch';
import { projectSetCommand, repoAddCommand } from '../engines/engineView';
import { useEngineMode } from '../engines/useEngineMode';
import type { ProjectSetupState } from './welcomeState';
import styles from './OwnerOnboarding.module.css';

/** The machine reports its projects only in its hello, so the page asks again until it holds this one. */
const POLL_MS = 5000;

/**
 * After the wizard created a project on the owner's own machine: the one command that makes the machine hold the
 * project's folder, and the machine's live answer. "Tovább a projekthez" works at any time.
 */
export function ProjectSetupPage() {
  const { projectKey = '' } = useParams();
  const location = useLocation();
  const given = (location.state ?? {}) as ProjectSetupState;
  const me = useMe();
  const engines = useProjectEngines(projectKey, POLL_MS);
  const [typedFolder, setTypedFolder] = useState('');
  const [mode] = useEngineMode();
  const name = me.data?.projects.find((project) => project.key === projectKey)?.name ?? projectKey;
  useDocumentTitle(t('ownerOnboarding.project.title', { name }));
  const folder = given.folder ?? typedFolder.trim();
  const base = engines.data?.engines.find((engine) => engine.isDefault) ?? engines.data?.engines[0];
  const holding = engines.data?.engines.some((engine) => engine.ownedByMe && engine.holdsProject) ?? false;
  return (
    <AuthLayout
      wide
      title={t('ownerOnboarding.project.title', { name })}
      subtitle={
        base
          ? t('ownerOnboarding.project.subtitle', { machine: base.name })
          : t('ownerOnboarding.project.subtitleNoMachine')
      }
    >
      {engines.isPending ? (
        <LoadingState />
      ) : engines.isError && !engines.data ? (
        <ErrorState error={engines.error} onRetry={() => void engines.refetch()} />
      ) : (
        <div className={styles.card}>
          <div className={styles.stepBody}>
            {given.folder === undefined ? (
              <TextField
                label={t('projects.create.workspace')}
                placeholder={t('projects.create.workspacePlaceholder')}
                value={typedFolder}
                onChange={(event) => setTypedFolder(event.target.value)}
                spellCheck={false}
              />
            ) : null}
            {folder ? (
              <>
                <EngineModeSwitch />
                <CopyRow
                  text={projectSetCommand(projectKey, folder, mode)}
                  label={t('ownerOnboarding.project.commandAria')}
                />
                {(given.repos ?? []).length > 0 ? (
                  <>
                    <p className={styles.line}>{t('ownerOnboarding.project.reposIntro')}</p>
                    {(given.repos ?? []).map((repo) => (
                      <CopyRow
                        key={repo.name}
                        text={repoAddCommand(projectKey, repo, folder, mode)}
                        label={t('ownerOnboarding.project.repoAria', { name: repo.name })}
                      />
                    ))}
                  </>
                ) : null}
              </>
            ) : null}
            <div className={styles.live} data-state={holding ? 'ok' : 'waiting'} role="status">
              <span className={styles.liveDot} aria-hidden="true" />
              <span>
                {t(holding ? 'ownerOnboarding.project.running' : 'ownerOnboarding.project.waiting')}
              </span>
            </div>
            <p className={styles.hint}>{t('ownerOnboarding.project.hint')}</p>
            <Fold summary={t('ownerOnboarding.project.optionalSummary')}>
              <p className={styles.line}>{t('ownerOnboarding.project.optionalBody')}</p>
              <Link to={`/p/${projectKey}/settings/integrator`}>
                {t('ownerOnboarding.project.optionalLink')}
              </Link>
            </Fold>
            <div className={`${styles.actions} ${styles.actionsEnd}`}>
              <ButtonLink
                to={`/p/${projectKey}`}
                state={{ operatorChecklist: true }}
                variant="primary"
                size="md"
              >
                {t('ownerOnboarding.project.continue')}
              </ButtonLink>
            </div>
          </div>
        </div>
      )}
    </AuthLayout>
  );
}
