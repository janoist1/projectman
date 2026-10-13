import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import clsx from 'clsx';
import type { CreateProjectRequest, ProjectConfig } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useCreateProject, useProjectPreview, useProjects, useTemplates } from '../../api/queries';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { ChoiceCard, TextField } from '../../components/Field';
import { MoverChoice } from '../../components/MoverChoice';
import type { MoverKind } from '../../components/MoverChoice';
import { ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { ErrorBanner } from '../../components/ErrorBanner';
import { t, tDynamic } from '../../i18n/t';
import type { IssueRef } from '../../lib/configIssues';
import { errorMessage } from '../../lib/errors';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from '../auth/AuthLayout';
import { InstancePauseBar } from '../pause/PauseBanner';
import { KEY_RE, WIZARD_STEPS, newRepo, reposPayload, suggestKey, validateRepos } from './projectForm';
import type { RepoErrors, RepoRow, WizardStep } from './projectForm';
import { WizardSummary, blockingIssues, issueText, summarySubtitle } from './WizardSummary';
import styles from './CreateProjectPage.module.css';

interface Errors {
  name?: string;
  key?: string;
  workspace?: string;
  template?: string;
}

/** Why the server refused a create: the issues of an invalid configuration, else the error's own words. */
function rejectionReason(error: unknown, config: ProjectConfig | undefined): string {
  if (isApiError(error)) {
    const issues = (error.details as { issues?: IssueRef[] } | undefined)?.issues;
    if (Array.isArray(issues) && issues.length > 0)
      return [...new Set(issues.map((issue) => issueText(config, issue)))].join(' ');
  }
  return errorMessage(error);
}

/** The "new project" wizard: name, kind, who moves the cards, where the code is, and a summary that checks it works. */
export function CreateProjectPage() {
  useDocumentTitle(t('projects.create.title'));
  const templates = useTemplates();
  const projects = useProjects();
  const create = useCreateProject();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>('name');
  const [reached, setReached] = useState(0);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [mover, setMover] = useState<MoverKind>('worker');
  const [errors, setErrors] = useState<Errors>({});
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [repoErrors, setRepoErrors] = useState<Record<number, RepoErrors>>({});
  const titleRef = useRef<HTMLHeadingElement>(null);
  const updateRepo = (id: number, patch: Partial<RepoRow>) =>
    setRepos((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const effectiveKey = keyTouched ? key : suggestKey(name);
  const selectedTemplate = templateId || templates.data?.[0]?.id || '';
  const isFirst = projects.data?.length === 0;
  const stepIndex = WIZARD_STEPS.indexOf(step);
  const onSummary = step === 'summary';

  const request: CreateProjectRequest = {
    key: effectiveKey,
    name: name.trim(),
    workspacePath: workspace.trim(),
    templateId: selectedTemplate,
    cardMover: mover === 'human' ? 'creator' : mover,
    ...(reposPayload(repos).length > 0 ? { repos: reposPayload(repos) } : {}),
  };
  const preview = useProjectPreview(onSummary ? request : null);
  const problems = preview.data ? blockingIssues(preview.data.issues) : [];
  const works = preview.data !== undefined && problems.length === 0;

  // A new step's title takes the focus, so a keyboard or screen reader user starts at its question.
  useEffect(() => {
    titleRef.current?.focus();
  }, [step]);

  const validate = (which: WizardStep): boolean => {
    const found: Errors = {};
    let foundRepos: Record<number, RepoErrors> = {};
    if (which === 'name') {
      if (!name.trim()) found.name = t('projects.validation.nameRequired');
      if (!KEY_RE.test(effectiveKey)) found.key = t('projects.validation.keyInvalid');
    }
    if (which === 'kind' && !selectedTemplate) found.template = t('projects.validation.templateRequired');
    if (which === 'code') {
      if (!workspace.trim()) found.workspace = t('projects.validation.workspaceRequired');
      foundRepos = validateRepos(repos);
    }
    setErrors(found);
    setRepoErrors(foundRepos);
    return Object.keys(found).length === 0 && Object.keys(foundRepos).length === 0;
  };

  const goTo = (target: WizardStep) => {
    setErrors({});
    setStep(target);
    setReached((value) => Math.max(value, WIZARD_STEPS.indexOf(target)));
  };

  const submit = () => {
    create.mutate(request, {
      onSuccess: () => {
        toast.show(t('projects.create.created', { name: name.trim() }));
        navigate(`/p/${effectiveKey}`, { replace: true });
      },
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!onSummary) {
      if (validate(step)) goTo(WIZARD_STEPS[stepIndex + 1]!);
      return;
    }
    if (works && !create.isPending) submit();
  };

  const stepName = (which: WizardStep) => t(`projects.create.stepsNames.${which}`);
  const kindName = selectedTemplate ? tDynamic(`templates.${selectedTemplate}.name`, selectedTemplate) : '';

  return (
    <>
      <InstancePauseBar />
      <AuthLayout
        wide
        title={isFirst ? t('projects.emptyTitle') : t('projects.create.title')}
        subtitle={
          isFirst
            ? `${t('projects.emptyBody')} ${t('projects.create.firstIntro')}`
            : t('projects.create.intro')
        }
      >
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <nav aria-label={t('projects.create.stepsLabel')}>
            <ol className={styles.steps}>
              {WIZARD_STEPS.map((which, index) => (
                <li key={which} className={styles.stepItem}>
                  <button
                    type="button"
                    className={clsx(
                      styles.stepButton,
                      index < stepIndex && styles.stepDone,
                      index === stepIndex && styles.stepNow,
                    )}
                    disabled={index > reached}
                    aria-current={index === stepIndex ? 'step' : undefined}
                    aria-label={t('projects.create.stepButton', {
                      n: index + 1,
                      total: WIZARD_STEPS.length,
                      name: stepName(which),
                    })}
                    onClick={() => goTo(which)}
                  >
                    <span className={styles.stepBar} aria-hidden="true" />
                    <span className={styles.stepName}>{stepName(which)}</span>
                  </button>
                </li>
              ))}
            </ol>
            <p className={styles.stepCompact} aria-hidden="true">
              {t('projects.create.stepCompact', {
                n: stepIndex + 1,
                total: WIZARD_STEPS.length,
                name: stepName(step),
              })}
            </p>
          </nav>

          <div key={step} className={styles.panel}>
            <h2 ref={titleRef} tabIndex={-1} className={styles.stepTitle}>
              {step === 'name'
                ? t('projects.create.nameTitle')
                : step === 'kind'
                  ? t('projects.create.kindTitle')
                  : step === 'mover'
                    ? t('projects.create.moverTitle')
                    : step === 'code'
                      ? t('projects.create.codeTitle')
                      : t('projects.create.summaryTitle')}
            </h2>

            {step === 'name' ? (
              <>
                <TextField
                  label={t('projects.create.name')}
                  placeholder={t('projects.create.namePlaceholder')}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  error={errors.name}
                  autoFocus
                />
                <TextField
                  label={t('projects.create.key')}
                  hint={t('projects.create.keyHint', { example: `${effectiveKey || 'AC'}-1` })}
                  value={effectiveKey}
                  onChange={(event) => {
                    setKeyTouched(true);
                    setKey(event.target.value.toUpperCase());
                  }}
                  error={errors.key}
                  maxLength={10}
                  spellCheck={false}
                  autoCapitalize="characters"
                />
              </>
            ) : null}

            {step === 'kind' ? (
              <fieldset className={styles.fieldset}>
                <legend className={clsx(styles.help, styles.legendHelp)}>
                  {t('projects.create.kindHelp')}
                </legend>
                {templates.isPending ? <LoadingState compact /> : null}
                {templates.isError ? (
                  <ErrorState compact error={templates.error} onRetry={() => void templates.refetch()} />
                ) : null}
                {templates.data && templates.data.length === 0 ? (
                  <p className={styles.muted}>{t('projects.create.noTemplates')}</p>
                ) : null}
                <div className={styles.templates}>
                  {(templates.data ?? []).map((template) => (
                    <ChoiceCard
                      key={template.id}
                      name="template"
                      value={template.id}
                      checked={selectedTemplate === template.id}
                      onChange={setTemplateId}
                      title={tDynamic(template.nameKey, template.id)}
                      description={
                        <>
                          {tDynamic(template.descriptionKey, '')}
                          <span className={styles.kindCounts}>
                            {t('projects.create.kindCounts', {
                              ai: template.memberCount.ai,
                              stages: template.stageCount,
                            })}
                          </span>
                        </>
                      }
                    />
                  ))}
                </div>
                <p className={styles.pmNote}>
                  <Avatar
                    member={{
                      handle: 'pm',
                      displayName: t('projects.create.pmName'),
                      kind: 'ai',
                      role: 'project_manager',
                    }}
                    size="xs"
                  />
                  {t('projects.create.kindPm')}
                </p>
                {errors.template ? (
                  <span className={styles.error} role="alert">
                    {errors.template}
                  </span>
                ) : null}
              </fieldset>
            ) : null}

            {step === 'mover' ? (
              <>
                <p className={styles.help}>{t('projects.create.moverHelp')}</p>
                <MoverChoice
                  name="mover"
                  value={mover}
                  onChange={setMover}
                  legend={t('projects.create.moverTitle')}
                  humanExtra={
                    <>
                      <b>{t('settings.team.mover.youMove')}</b> {t('settings.team.mover.youMoveLater')}
                    </>
                  }
                />
              </>
            ) : null}

            {step === 'code' ? (
              <>
                <p className={styles.help}>{t('projects.create.codeHelp')}</p>
                <TextField
                  label={t('projects.create.workspace')}
                  hint={t('projects.create.workspaceHint')}
                  placeholder={t('projects.create.workspacePlaceholder')}
                  value={workspace}
                  onChange={(event) => setWorkspace(event.target.value)}
                  error={errors.workspace}
                  spellCheck={false}
                  autoFocus
                />
                <details className={styles.repos} open={repos.length > 0}>
                  <summary>{t('projects.create.reposToggle')}</summary>
                  <p className={styles.muted}>{t('projects.create.reposHint')}</p>
                  {repos.map((row, index) => (
                    <div
                      key={row.id}
                      className={styles.repo}
                      role="group"
                      aria-label={t('projects.create.repoLabel', { index: index + 1 })}
                    >
                      <div className={styles.repoGrid}>
                        <TextField
                          label={t('projects.create.repoName')}
                          value={row.name}
                          onChange={(event) => updateRepo(row.id, { name: event.target.value.toLowerCase() })}
                          error={repoErrors[row.id]?.name}
                          spellCheck={false}
                        />
                        <TextField
                          label={t('projects.create.repoPath')}
                          value={row.path}
                          onChange={(event) => updateRepo(row.id, { path: event.target.value })}
                          error={repoErrors[row.id]?.path}
                          spellCheck={false}
                        />
                        <TextField
                          label={t('projects.create.repoGithub')}
                          value={row.github}
                          onChange={(event) => updateRepo(row.id, { github: event.target.value })}
                          error={repoErrors[row.id]?.github}
                          optional
                          spellCheck={false}
                        />
                        <TextField
                          label={t('projects.create.repoBranch')}
                          value={row.defaultBranch}
                          onChange={(event) => updateRepo(row.id, { defaultBranch: event.target.value })}
                          spellCheck={false}
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="close"
                        onClick={() => setRepos((rows) => rows.filter((entry) => entry.id !== row.id))}
                        aria-label={t('projects.create.removeRepo', {
                          name: row.name || t('projects.create.repoLabel', { index: index + 1 }),
                        })}
                      />
                    </div>
                  ))}
                  <Button
                    variant="secondary"
                    size="md"
                    icon="plus"
                    onClick={() => setRepos((rows) => [...rows, newRepo()])}
                  >
                    {t('projects.create.addRepo')}
                  </Button>
                </details>
              </>
            ) : null}

            {onSummary ? (
              <>
                <p className={styles.help}>{summarySubtitle(kindName, name.trim(), effectiveKey)}</p>
                {preview.isPending ? (
                  <div className={styles.loading} aria-busy="true">
                    <p>{t('projects.create.summaryLoading')}</p>
                    <span className={styles.skeleton} />
                    <span className={styles.skeleton} />
                    <span className={styles.skeleton} />
                  </div>
                ) : null}
                {preview.isError ? (
                  <ErrorState
                    compact
                    error={preview.error}
                    message={t('projects.create.summaryFailed')}
                    onRetry={() => void preview.refetch()}
                  />
                ) : null}
                {preview.data ? (
                  <WizardSummary preview={preview.data} moverKind={mover} onFix={goTo} />
                ) : null}
              </>
            ) : null}
          </div>

          <div className={styles.bar}>
            {create.isError ? (
              <ErrorBanner>
                {t('projects.create.rejected', {
                  reason: rejectionReason(create.error, preview.data?.config),
                })}
              </ErrorBanner>
            ) : null}
            {onSummary && preview.data && !works ? (
              <p id="create-blocked" className={styles.blocked}>
                {t('projects.create.cannotSubmit')}
              </p>
            ) : null}
            <div className={styles.actions}>
              {stepIndex > 0 ? (
                <Button
                  variant="secondary"
                  size="md"
                  icon="chevronLeft"
                  onClick={() => goTo(WIZARD_STEPS[stepIndex - 1]!)}
                >
                  {t('projects.create.back')}
                </Button>
              ) : null}
              {onSummary ? (
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  loading={create.isPending}
                  aria-disabled={!works || undefined}
                  aria-describedby={preview.data && !works ? 'create-blocked' : undefined}
                  onClick={(event) => {
                    if (!works) event.preventDefault();
                  }}
                >
                  {create.isPending ? t('projects.create.submitting') : t('projects.create.submit')}
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  iconRight="chevronRight"
                  disabled={step === 'kind' && (templates.isPending || !selectedTemplate)}
                >
                  {t('projects.create.next')}
                </Button>
              )}
            </div>
          </div>
        </form>
      </AuthLayout>
    </>
  );
}
