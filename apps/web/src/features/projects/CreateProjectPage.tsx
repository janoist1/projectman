import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { starterProvider, type AgentProvider, type CreateProjectRequest } from '@projectman/shared';
import { useCreateProject, useProjects, useProviders } from '../../api/queries';
import { Button } from '../../components/Button';
import { SelectField, TextField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { ErrorBanner } from '../../components/ErrorBanner';
import { t } from '../../i18n/t';
import { errorCode, errorMessage } from '../../lib/errors';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from '../auth/AuthLayout';
import { InstancePauseBar } from '../pause/PauseBanner';
import { KEY_RE, newRepo, reposPayload, suggestKey, validateRepos } from './projectForm';
import type { RepoErrors, RepoRow } from './projectForm';
import { ProviderChoice } from './ProviderChoice';
import styles from './CreateProjectPage.module.css';

interface Errors {
  name?: string;
  key?: string;
  workspace?: string;
}

export function CreateProjectPage() {
  useDocumentTitle(t('projects.create.title'));
  const projects = useProjects();
  const providers = useProviders();
  const create = useCreateProject();
  const toast = useToast();
  const navigate = useNavigate();
  const form = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [language, setLanguage] = useState<'hu' | 'en'>('hu');
  const [chosenProvider, setChosenProvider] = useState<AgentProvider | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [repoErrors, setRepoErrors] = useState<Record<number, RepoErrors>>({});
  const provider =
    chosenProvider ??
    (providers.isError ? 'claude' : (starterProvider(providers.data?.providers ?? []) ?? 'claude'));
  const effectiveKey = keyTouched ? key : suggestKey(name);
  const updateRepo = (id: number, patch: Partial<RepoRow>) =>
    setRepos((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const focusError = () =>
    requestAnimationFrame(() => {
      const field = form.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]');
      const details = field?.closest('details');
      if (details) details.open = true;
      field?.focus();
    });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (providers.isPending || submitting.current) return;
    const found: Errors = {};
    if (!name.trim()) found.name = t('projects.validation.nameRequired');
    if (!KEY_RE.test(effectiveKey)) found.key = t('projects.validation.keyInvalid');
    if (!workspace.trim()) found.workspace = t('projects.validation.workspaceRequired');
    const foundRepos = validateRepos(repos);
    setErrors(found);
    setRepoErrors(foundRepos);
    if (Object.keys(found).length || Object.keys(foundRepos).length) {
      focusError();
      return;
    }
    const request: CreateProjectRequest = {
      key: effectiveKey,
      name: name.trim(),
      workspacePath: workspace.trim(),
      language,
      provider,
      ...(reposPayload(repos).length ? { repos: reposPayload(repos) } : {}),
    };
    submitting.current = true;
    create.mutate(request, {
      onSuccess: () => {
        toast.show(t('projects.create.created', { name: name.trim() }));
        navigate(`/p/${effectiveKey}`, { replace: true, state: { operatorChecklist: true } });
      },
      onError: (error) => {
        if (errorCode(error) === 'workspace_not_found') {
          setErrors({ workspace: t('errors.codes.workspace_not_found') });
          focusError();
        }
      },
      onSettled: () => {
        submitting.current = false;
      },
    });
  };
  return (
    <>
      <InstancePauseBar />
      <AuthLayout
        wide
        title={projects.data?.length === 0 ? t('projects.emptyTitle') : t('projects.create.title')}
        subtitle={`${projects.data?.length === 0 ? `${t('projects.emptyBody')} ` : ''}${t('projects.create.intro')}`}
      >
        <form ref={form} className={styles.form} onSubmit={onSubmit} noValidate>
          <section className={styles.section} aria-labelledby="project-title">
            <h2 id="project-title">{t('projects.create.projectTitle')}</h2>
            <div className={styles.nameGrid}>
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
                hint={t('projects.create.keyHint', {
                  example: t('projects.create.keyExample', { key: effectiveKey || 'AC' }),
                })}
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
            </div>
            <SelectField
              label={t('projects.create.language')}
              hint={t('projects.create.languageHint')}
              value={language}
              onChange={(event) => setLanguage(event.target.value as 'hu' | 'en')}
            >
              <option value="hu">{t('projects.create.hungarian')}</option>
              <option value="en">{t('projects.create.english')}</option>
            </SelectField>
          </section>
          <section className={styles.section} aria-labelledby="code-title">
            <h2 id="code-title">{t('projects.create.codeTitle')}</h2>
            <TextField
              label={t('projects.create.workspace')}
              hint={t('projects.create.workspaceHint')}
              placeholder={t('projects.create.workspacePlaceholder')}
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              error={errors.workspace}
              spellCheck={false}
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
          </section>
          <ProviderChoice query={providers} value={provider} onChange={setChosenProvider} />
          <div className={styles.bar}>
            {create.isError && errorCode(create.error) !== 'workspace_not_found' ? (
              <ErrorBanner>
                {t('projects.create.rejected', { reason: errorMessage(create.error) })}
              </ErrorBanner>
            ) : null}
            <div className={styles.actions}>
              <p className={styles.starter}>
                {t('projects.create.starterPrefix')}{' '}
                <strong>{t('projects.create.starterTeam', { provider: t(`providers.${provider}`) })}</strong>
                {t('projects.create.starterSuffix')}
              </p>
              <Button
                type="submit"
                variant="primary"
                size="md"
                loading={create.isPending}
                aria-disabled={providers.isPending || undefined}
                aria-describedby={providers.isPending ? 'providers-pending' : undefined}
              >
                {t(create.isPending ? 'projects.create.submitting' : 'projects.create.submit')}
              </Button>
            </div>
            {providers.isPending ? (
              <p id="providers-pending" className={styles.muted}>
                {t('projects.create.providersPending')}
              </p>
            ) : null}
          </div>
        </form>
      </AuthLayout>
    </>
  );
}
