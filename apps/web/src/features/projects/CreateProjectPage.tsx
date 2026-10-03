import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { CreateProjectRequest } from '@projectman/shared';
import { useCreateProject, useProjects, useTemplates } from '../../api/queries';
import { Button } from '../../components/Button';
import { ChoiceCard, TextField } from '../../components/Field';
import { ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { ErrorBanner } from '../../components/ErrorBanner';
import { t, tDynamic } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from '../auth/AuthLayout';
import { InstancePauseBar } from '../pause/PauseBanner';
import { KEY_RE, newRepo, reposPayload, suggestKey, validateRepos } from './projectForm';
import type { RepoErrors, RepoRow } from './projectForm';
import styles from './CreateProjectPage.module.css';

interface Errors {
  name?: string;
  key?: string;
  workspace?: string;
  template?: string;
}

/** New project from a team template (also shown when there is no project yet). */
export function CreateProjectPage() {
  useDocumentTitle(t('projects.create.title'));
  const templates = useTemplates();
  const projects = useProjects();
  const create = useCreateProject();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [repoErrors, setRepoErrors] = useState<Record<number, RepoErrors>>({});
  const updateRepo = (id: number, patch: Partial<RepoRow>) =>
    setRepos((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const effectiveKey = keyTouched ? key : suggestKey(name);
  const selectedTemplate = templateId || templates.data?.[0]?.id || '';
  const isFirst = projects.data?.length === 0;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found: Errors = {};
    if (!name.trim()) found.name = t('projects.validation.nameRequired');
    if (!KEY_RE.test(effectiveKey)) found.key = t('projects.validation.keyInvalid');
    if (!workspace.trim()) found.workspace = t('projects.validation.workspaceRequired');
    if (!selectedTemplate) found.template = t('projects.validation.templateRequired');
    const foundRepos = validateRepos(repos);
    setErrors(found);
    setRepoErrors(foundRepos);
    if (Object.keys(found).length > 0 || Object.keys(foundRepos).length > 0) return;
    const repoList = reposPayload(repos);
    // `repos` is optional in the contract (newer servers accept it).
    const body: CreateProjectRequest & { repos?: ReturnType<typeof reposPayload> } = {
      key: effectiveKey,
      name: name.trim(),
      workspacePath: workspace.trim(),
      templateId: selectedTemplate,
      ...(repoList.length > 0 ? { repos: repoList } : {}),
    };
    create.mutate(body, {
      onSuccess: () => {
        toast.show(t('projects.create.created', { name: name.trim() }));
        navigate(`/p/${effectiveKey}`, { replace: true });
      },
    });
  };

  return (
    <>
      <InstancePauseBar />
      <AuthLayout
        wide
        title={isFirst ? t('projects.emptyTitle') : t('projects.create.title')}
        subtitle={
          isFirst ? `${t('projects.emptyBody')} ${t('projects.create.intro')}` : t('projects.create.intro')
        }
      >
        <form className={styles.form} onSubmit={onSubmit} noValidate>
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
          <TextField
            label={t('projects.create.workspace')}
            hint={t('projects.create.workspaceHint')}
            placeholder={t('projects.create.workspacePlaceholder')}
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            error={errors.workspace}
            spellCheck={false}
          />
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('projects.create.repos')}</legend>
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
          </fieldset>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('projects.create.template')}</legend>
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
                  description={[
                    tDynamic(template.descriptionKey, ''),
                    t('projects.create.templateCounts', {
                      humans: template.memberCount.human,
                      ai: template.memberCount.ai,
                      stages: template.stageCount,
                    }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
            </div>
            {errors.template ? (
              <span className={styles.error} role="alert">
                {errors.template}
              </span>
            ) : null}
          </fieldset>
          <div className={styles.bar}>
            {create.isError ? <ErrorBanner>{errorMessage(create.error)}</ErrorBanner> : null}
            <Button type="submit" variant="primary" size="md" loading={create.isPending}>
              {create.isPending ? t('projects.create.submitting') : t('projects.create.submit')}
            </Button>
          </div>
        </form>
      </AuthLayout>
    </>
  );
}
