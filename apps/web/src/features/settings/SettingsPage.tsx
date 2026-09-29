import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { ConfigVersionEntry, MemberConfig, ProjectConfig } from '@projectman/shared';
import { useConfig, useLogout, useRevertConfig } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Dialog } from '../../components/Dialog';
import { ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/Toast';
import { formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useDocumentTitle } from '../../lib/hooks';
import { gateConditionText } from '../../lib/gates';
import { nameOf, roleLabel } from '../../lib/members';
import styles from './SettingsPage.module.css';

function memberRole(member: MemberConfig): string {
  return member.kind === 'human'
    ? roleLabel({ handle: member.handle, displayName: member.displayName, kind: 'human', role: member.access })
    : roleLabel({ handle: member.handle, displayName: member.displayName, kind: 'ai', role: member.role, specialty: member.specialty });
}

function PipelineSection({ config }: { config: ProjectConfig }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const byHandle = new Map(config.team.members.map((member) => [member.handle, member]));
  return (
    <section className={styles.card} aria-labelledby="settings-pipeline">
      <div className={styles.cardHead}>
        <h2 id="settings-pipeline" className={styles.cardTitle}>
          {t('settings.sections.pipeline')}
        </h2>
        <span className={styles.muted}>{t('settings.pipeline.stageCount', { count: config.pipeline.stages.length })}</span>
      </div>
      <ol className={styles.columns}>
        {config.pipeline.columns.map((column) => {
          const stages = config.pipeline.stages.filter((stage) => stage.columnId === column.id);
          return (
            <li key={column.id} className={styles.column}>
              <div className={styles.columnHead}>
                <span className={styles.columnName}>{column.name}</span>
                {column.hint ? <span className={styles.muted}>{column.hint}</span> : null}
              </div>
              <ol className={styles.stages}>
                {stages.map((stage) => (
                  <li key={stage.id} className={styles.stage}>
                    <div className={styles.stageTop}>
                      <span className={styles.stageName}>{stage.name}</span>
                      <Chip>{t(`stageKinds.${stage.kind}`)}</Chip>
                      <code className={styles.id}>{stage.id}</code>
                    </div>
                    <div className={styles.owners}>
                      <span className={styles.label}>{t('settings.pipeline.owners')}</span>
                      {stage.owners.length === 0 ? (
                        <span className={styles.muted}>{t('settings.pipeline.noOwners')}</span>
                      ) : (
                        stage.owners.map((handle) => {
                          const member = byHandle.get(handle);
                          return (
                            <span key={handle} className={styles.owner}>
                              <Avatar
                                member={
                                  member
                                    ? {
                                        handle,
                                        displayName: member.displayName,
                                        kind: member.kind,
                                        role: member.kind === 'human' ? member.access : member.role,
                                        specialty: member.kind === 'ai' ? member.specialty : null,
                                      }
                                    : members.get(handle)
                                }
                                handle={handle}
                                isMe={handle === myHandle}
                                size="xs"
                              />
                              {nameOf(handle, members, myHandle)}
                            </span>
                          );
                        })
                      )}
                    </div>
                    {stage.gate ? (
                      <div className={styles.gate}>
                        <span className={styles.label}>{t('settings.pipeline.gate')}</span>
                        {stage.gate.conditions.map((condition, index) => (
                          <Chip key={index} tone="needs" icon="lock">
                            {gateConditionText(condition, members, myHandle)}
                          </Chip>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TeamSection({ config }: { config: ProjectConfig }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  return (
    <section className={styles.card} aria-labelledby="settings-team">
      <h2 id="settings-team" className={styles.cardTitle}>
        {t('settings.sections.team')}
      </h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('settings.team.name')}</th>
              <th scope="col">{t('settings.team.handle')}</th>
              <th scope="col">{t('settings.team.role')}</th>
              <th scope="col">{t('settings.team.model')}</th>
              <th scope="col">{t('settings.team.permissions')}</th>
              <th scope="col">{t('settings.team.capacity')}</th>
              <th scope="col">{t('settings.team.sponsor')}</th>
            </tr>
          </thead>
          <tbody>
            {config.team.members.map((member) => (
              <tr key={member.handle}>
                <td className={styles.strong}>
                  {member.displayName}
                  {member.kind === 'ai' ? (
                    <>
                      {' '}
                      <Chip tone="dark">{t('common.ai')}</Chip>
                    </>
                  ) : null}
                </td>
                <td>
                  <code className={styles.id}>{member.handle}</code>
                </td>
                <td>{memberRole(member)}</td>
                <td>{member.kind === 'ai' ? member.model : t('common.dash')}</td>
                <td>{member.kind === 'ai' ? t(`permissionModes.${member.permissionMode}`) : t('common.dash')}</td>
                <td>{member.kind === 'ai' ? t('hire.capacityValue', { count: member.capacity }) : t('common.dash')}</td>
                <td>{member.kind === 'ai' ? nameOf(member.sponsor, members, myHandle) : t('common.dash')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LimitsAndRepos({ config }: { config: ProjectConfig }) {
  const { limits } = config.team;
  return (
    <>
      <section className={styles.card} aria-labelledby="settings-limits">
        <h2 id="settings-limits" className={styles.cardTitle}>
          {t('settings.sections.limits')}
        </h2>
        <dl className={styles.facts}>
          <div>
            <dt>{t('settings.limits.maxConcurrentAi')}</dt>
            <dd>{t('settings.limits.maxConcurrentAiValue', { count: limits.maxConcurrentAi })}</dd>
          </div>
          <div>
            <dt>{t('settings.limits.pauseAbove')}</dt>
            <dd>{t('settings.limits.pauseAboveValue', { percent: limits.pauseAbovePlanUsagePercent })}</dd>
          </div>
          <div>
            <dt>{t('settings.limits.tempWorkers')}</dt>
            <dd>
              {limits.tempWorkers.enabled
                ? t('settings.limits.tempWorkersOn', { max: limits.tempWorkers.max, role: t(`roles.ai.${limits.tempWorkers.role}`) })
                : t('settings.limits.tempWorkersOff')}
            </dd>
          </div>
        </dl>
      </section>
      <section className={styles.card} aria-labelledby="settings-repos">
        <h2 id="settings-repos" className={styles.cardTitle}>
          {t('settings.sections.repos')}
        </h2>
        {config.project.repos.length === 0 ? (
          <p className={styles.muted}>{t('settings.repos.none')}</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('settings.repos.name')}</th>
                  <th scope="col">{t('settings.repos.path')}</th>
                  <th scope="col">{t('settings.repos.github')}</th>
                  <th scope="col">{t('settings.repos.defaultBranch')}</th>
                </tr>
              </thead>
              <tbody>
                {config.project.repos.map((repo) => (
                  <tr key={repo.name}>
                    <td className={styles.strong}>{repo.name}</td>
                    <td>
                      <code className={styles.id}>{repo.path}</code>
                    </td>
                    <td>{repo.github ? <code className={styles.id}>{repo.github}</code> : t('common.dash')}</td>
                    <td>
                      <code className={styles.id}>{repo.defaultBranch}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function HistorySection({ history, current, canRevert }: { history: ConfigVersionEntry[]; current: string; canRevert: boolean }) {
  const { key } = useProject();
  const revert = useRevertConfig(key);
  const toast = useToast();
  const [target, setTarget] = useState<ConfigVersionEntry | null>(null);
  return (
    <section className={styles.card} aria-labelledby="settings-history">
      <h2 id="settings-history" className={styles.cardTitle}>
        {t('settings.sections.history')}
      </h2>
      {history.length === 0 ? <p className={styles.muted}>{t('settings.history.empty')}</p> : null}
      <ol className={styles.history}>
        {history.map((entry) => {
          const isCurrent = entry.version === current;
          return (
            <li key={entry.version} className={styles.version}>
              <code className={styles.versionTag}>{entry.version.slice(0, 7)}</code>
              <div className={styles.versionText}>
                <span className={styles.versionMessage}>{entry.message}</span>
                <span className={styles.muted}>{t('settings.history.by', { author: entry.author, time: formatStamp(entry.at) })}</span>
              </div>
              {isCurrent ? (
                <Chip tone="ok">{t('settings.history.current')}</Chip>
              ) : canRevert ? (
                <Button variant="secondary" size="sm" icon="undo" onClick={() => setTarget(entry)}>
                  {t('settings.history.revert')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {!canRevert ? <p className={styles.muted}>{t('settings.history.ownerOnly')}</p> : null}
      <Dialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? t('settings.history.revertTitle', { version: target.version.slice(0, 7) }) : ''}
        description={t('settings.history.revertBody')}
        size="sm"
        footer={
          <>
            <Button
              variant="primary"
              icon="undo"
              loading={revert.isPending}
              onClick={() => {
                if (!target) return;
                revert.mutate(target.version, {
                  onSuccess: () => {
                    toast.show(t('settings.history.reverted', { version: target.version.slice(0, 7) }));
                    setTarget(null);
                  },
                  onError: (error) => toast.show(errorMessage(error), 'error'),
                });
              }}
            >
              {t('settings.history.revert')}
            </Button>
            <Button variant="secondary" onClick={() => setTarget(null)}>
              {t('common.cancel')}
            </Button>
          </>
        }
      />
    </section>
  );
}

function AccountSection() {
  const { me, myHandle } = useProject();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <section className={styles.card} aria-labelledby="settings-account">
      <h2 id="settings-account" className={styles.cardTitle}>
        {t('settings.sections.account')}
      </h2>
      <dl className={styles.facts}>
        <div>
          <dt>{t('settings.account.name')}</dt>
          <dd>{me.name}</dd>
        </div>
        <div>
          <dt>{t('settings.account.email')}</dt>
          <dd>{me.email}</dd>
        </div>
        {myHandle ? (
          <div>
            <dt>{t('settings.account.handle')}</dt>
            <dd>
              <code className={styles.id}>{myHandle}</code>
            </dd>
          </div>
        ) : null}
      </dl>
      <Button
        variant="secondary"
        icon="logout"
        loading={logout.isPending}
        onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}
      >
        {t('settings.account.logout')}
      </Button>
    </section>
  );
}

/** Project configuration (read-only in v1) with version history and revert. */
export function SettingsPage() {
  const { key, isOwner } = useProject();
  const config = useConfig(key);
  useDocumentTitle(t('settings.title'), config.data?.config.project.name);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titles}>
          <h1 className={styles.title}>{t('settings.title')}</h1>
          <p className={styles.subtitle}>{t('settings.subtitle')}</p>
        </div>
        {config.data ? (
          <Chip tone="outline" size="md" mono>
            {t('settings.version', { version: config.data.version.slice(0, 7) })}
          </Chip>
        ) : null}
      </header>
      <div className={styles.grid}>
        <div className={styles.mainCol}>
          {config.isPending ? <LoadingState /> : null}
          {config.isError ? (
            <section className={styles.card}>
              <p className={styles.muted}>{t('settings.unavailable')}</p>
              <ErrorState compact error={config.error} onRetry={() => void config.refetch()} />
            </section>
          ) : null}
          {config.data ? (
            <>
              <section className={styles.card} aria-labelledby="settings-project">
                <h2 id="settings-project" className={styles.cardTitle}>
                  {t('settings.sections.project')}
                </h2>
                <dl className={styles.facts}>
                  <div>
                    <dt>{t('settings.project.name')}</dt>
                    <dd>{config.data.config.project.name}</dd>
                  </div>
                  <div>
                    <dt>{t('settings.project.key')}</dt>
                    <dd>
                      <code className={styles.id}>{config.data.config.project.key}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>{t('settings.project.workspace')}</dt>
                    <dd>
                      <code className={styles.id}>{config.data.config.project.workspacePath}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>{t('settings.project.language')}</dt>
                    <dd>{config.data.config.project.language}</dd>
                  </div>
                </dl>
              </section>
              <PipelineSection config={config.data.config} />
              <TeamSection config={config.data.config} />
              <LimitsAndRepos config={config.data.config} />
            </>
          ) : null}
        </div>
        <aside className={styles.sideCol}>
          {config.data ? (
            <HistorySection history={config.data.history} current={config.data.version} canRevert={isOwner} />
          ) : null}
          <AccountSection />
        </aside>
      </div>
    </div>
  );
}
