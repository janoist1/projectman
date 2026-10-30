import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { MemberContextPreview } from '@projectman/shared';
import { useBoard, useMemberContext, useMembers, useRoles } from '../../api/queries';
import { isApiError } from '../../api/client';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Fold } from '../../components/Fold';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, Spinner } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { intlLocale, numberFormat } from '../../i18n/format';
import { t } from '../../i18n/t';
import { aiRoleView } from '../../lib/roles';
import { useDocumentTitle } from '../../lib/hooks';
import { TaskPicker } from './TaskPicker';
import styles from './MemberContextPage.module.css';

const number = (value: number) => numberFormat().format(value).replace(/\s/g, '\u202f');
const firstUseKey = 'memberContext.introductionDismissed';
type Part = 'intro' | 'guides' | 'tools';

function generatedTime(stamp: string) {
  const date = new Date(stamp);
  return date.toDateString() === new Date().toDateString()
    ? t('memberContext.today', { time: date.toLocaleTimeString(intlLocale()) })
    : date.toLocaleString(intlLocale());
}

export function MemberContextPage() {
  const { handle = '' } = useParams();
  const { key, me } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const owner = access === 'owner';
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const task = params.get('task') ?? undefined;
  const selected = params.get('part');
  const part: Part = selected === 'guides' || selected === 'tools' ? selected : 'intro';
  const [taskMode, setTaskMode] = useState(task !== undefined);
  // An unselected task situation is local; a selected one always follows browser navigation.
  useEffect(() => setTaskMode(task !== undefined), [task]);
  const onTask = task !== undefined || taskMode;
  const members = useMembers(key);
  const board = useBoard(key);
  const roles = useRoles(key);
  const member = members.data?.find((entry) => entry.handle === handle);
  const preview = useMemberContext(key, handle, task, owner && (!onTask || task !== undefined));
  const [firstUse, setFirstUse] = useState(() => {
    try {
      return localStorage.getItem(firstUseKey) !== 'yes';
    } catch {
      return true;
    }
  });
  useDocumentTitle(t('memberContext.title'), board.data?.project.name);
  function changeParams(change: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(params);
    change(next);
    setParams(next);
  }
  const code = isApiError(preview.error) ? preview.error.code : undefined;
  const taskError =
    task !== undefined &&
    (code === 'task_not_found' || code === 'invalid_request' || code === 'task_is_theme')
      ? t(code === 'task_is_theme' ? 'memberContext.taskIsTheme' : 'memberContext.taskNotFound', { task })
      : undefined;
  const forbidden = !owner || code === 'insufficient_access';
  const missing = code === 'not_found';
  const human = code === 'not_ai_member';
  const data =
    !preview.error && !preview.isFetching && (!onTask || task !== undefined) ? preview.data : undefined;
  const role =
    member?.kind === 'ai' ? aiRoleView(member.role, member.specialty, roles.data?.roles) : undefined;
  return (
    <div className={styles.page}>
      <Link className={styles.back} to={`/p/${key}/team/${handle}`}>
        ‹ {member?.displayName ?? t('memberContext.backToProfile')}
      </Link>
      <header>
        <h1>{t('memberContext.title')}</h1>
        {member && (
          <p>
            {member.displayName}
            {role ? ` · ${role.name}` : ''}
          </p>
        )}
      </header>
      {forbidden ? (
        <EmptyState
          icon="lock"
          className={styles.memberState}
          title={t('memberContext.ownerTitle')}
          body={t('memberContext.ownerOnly')}
          action={
            <Link className={styles.back} to={`/p/${key}/team/${handle}`}>
              {t('memberContext.backToProfile')}
            </Link>
          }
        />
      ) : (
        <>
          {firstUse && (
            <aside className={styles.welcome}>
              <p>{t('memberContext.firstUse')}</p>
              <Button
                variant="ghost"
                onClick={() => {
                  setFirstUse(false);
                  try {
                    localStorage.setItem(firstUseKey, 'yes');
                  } catch {
                    /* The notice can still be dismissed for this visit. */
                  }
                }}
              >
                {t('memberContext.firstUseOk')}
              </Button>
            </aside>
          )}
          <div className={styles.controls}>
            <label>
              {t('memberContext.member')}
              <select
                value={handle}
                onChange={(event) => {
                  navigate(`/p/${key}/team/${event.target.value}/context?${params.toString()}`);
                }}
              >
                {!members.data?.some((entry) => entry.handle === handle && entry.kind === 'ai') && (
                  <option value={handle} disabled>
                    {member?.displayName ?? handle}
                  </option>
                )}
                {members.data
                  ?.filter((entry) => entry.kind === 'ai')
                  .map((entry) => (
                    <option key={entry.handle} value={entry.handle}>
                      {entry.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <div
              className={styles.situation}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  const value = event.key === 'ArrowRight';
                  setTaskMode(value);
                  if (!value) changeParams((next) => next.delete('task'));
                }
              }}
            >
              <span>{t('memberContext.situation')}</span>
              <SegmentedControl
                label={t('memberContext.situation')}
                options={[
                  { value: 'general', label: t('memberContext.general') },
                  { value: 'task', label: t('memberContext.onTask') },
                ]}
                value={onTask ? 'task' : 'general'}
                onChange={(value) => {
                  setTaskMode(value === 'task');
                  if (value === 'general') changeParams((next) => next.delete('task'));
                }}
              />
            </div>
            {onTask && (
              <TaskPicker
                tasks={board.data?.tasks ?? []}
                value={task ?? ''}
                error={taskError}
                onChange={(value) => changeParams((next) => next.set('task', value))}
              />
            )}
          </div>
          {!missing && !human && !taskError && !preview.error && (!onTask || task !== undefined) && (
            <aside className={styles.preview}>
              <div>
                {data ? (
                  <>
                    <strong>
                      {data.situation.kind === 'task'
                        ? t('memberContext.previewOnTask', { task: data.situation.taskKey })
                        : t('memberContext.preview')}
                    </strong>
                    <p>
                      <time dateTime={data.generatedAt}>
                        {t('memberContext.generatedAt', { time: generatedTime(data.generatedAt) })}
                      </time>
                    </p>
                    {data.member.onLeave && <p>{t('memberContext.onLeave')}</p>}
                  </>
                ) : (
                  <span role="status">
                    <Spinner /> {t('memberContext.loading')}
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                aria-disabled={preview.isFetching}
                onClick={() => void preview.refetch()}
              >
                {t('memberContext.refresh')}
              </Button>
            </aside>
          )}
          {missing ? (
            <EmptyState
              icon="search"
              className={styles.memberState}
              title={t('memberContext.memberNotFound')}
              body={t('memberContext.chooseAi')}
              action={
                <Link className={styles.back} to={`/p/${key}/team`}>
                  {t('memberContext.backToTeam')}
                </Link>
              }
            />
          ) : human ? (
            <EmptyState
              icon="team"
              className={styles.memberState}
              title={t('memberContext.human', { name: member?.displayName ?? handle })}
              body={t('memberContext.chooseAi')}
            />
          ) : onTask && task === undefined ? (
            <p>{t('memberContext.chooseTask')}</p>
          ) : taskError ? null : preview.error ? (
            <ErrorState
              error={preview.error}
              message={t('memberContext.error')}
              onRetry={() => void preview.refetch()}
            />
          ) : preview.isFetching || !data ? (
            <div className={styles.loading}>
              <div className={styles.skeleton} aria-hidden="true" />
            </div>
          ) : (
            <>
              <section className={styles.panel}>
                <div className={styles.chips}>
                  <Chip tone="neutral">{aiRoleView(data.member.role, null, roles.data?.roles).name}</Chip>
                  {data.member.duties.length ? (
                    data.member.duties.map((duty) => <Chip key={duty}>{t(`dutyNames.${duty}`)}</Chip>)
                  ) : (
                    <span>{t('memberContext.noDuties')}</span>
                  )}
                </div>
                <div className={styles.tiles}>
                  {(['intro', 'guides', 'tools'] as const).map((item) => (
                    <button
                      type="button"
                      key={item}
                      aria-current={part === item ? 'true' : undefined}
                      onClick={() => changeParams((next) => next.set('part', item))}
                    >
                      <strong>{number(item === 'intro' ? data.prompt.chars : data[item].length)}</strong>
                      <span>
                        {t(`memberContext.parts.${item}`, {
                          count: item === 'intro' ? data.prompt.chars : data[item].length,
                        })}
                      </span>
                      {item === 'intro' && (
                        <small>
                          {t('memberContext.sections', { count: number(data.prompt.sections.length) })}
                        </small>
                      )}
                    </button>
                  ))}
                </div>
              </section>
              <ContextPart
                key={`${handle}:${task ?? ''}:${part}:${data.generatedAt}`}
                data={data}
                part={part}
              />
            </>
          )}
        </>
      )}
      <span className={styles.srOnly} aria-live="polite">
        {data && !forbidden ? t('memberContext.ready') : ''}
      </span>
    </div>
  );
}

function ContextPart({ data, part }: { data: MemberContextPreview; part: Part }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const toast = useToast();
  const intro = [
    ...(data.initialMessage
      ? [
          {
            id: 'initialMessage',
            title: t(data.situation.kind === 'task' ? 'memberContext.kickoffTask' : 'memberContext.kickoff'),
            ...data.initialMessage,
          },
        ]
      : []),
    ...data.prompt.sections,
  ];
  const allOpen = intro.every((section) => open.has(section.id));
  function toggle(id: string, value: boolean) {
    setOpen((before) => {
      const next = new Set(before);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  const tools = data.tools.filter((tool) =>
    `${tool.name} ${tool.title} ${tool.description}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  return (
    <section className={styles.panel}>
      <div className={styles.partHeader}>
        <h2>
          {t(
            part === 'intro'
              ? 'memberContext.introTitle'
              : part === 'guides'
                ? 'memberContext.guidesTitle'
                : 'memberContext.toolsTitle',
          )}
          {part === 'tools' ? ` · ${number(data.tools.length)}` : ''}
        </h2>
        {part === 'intro' && (
          <div className={styles.actions}>
            <Button
              variant="ghost"
              onClick={() => setOpen(allOpen ? new Set() : new Set(intro.map((section) => section.id)))}
            >
              {t(allOpen ? 'memberContext.collapseAll' : 'memberContext.expandAll')}
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(data.prompt.text);
                  const message = t('memberContext.copied');
                  setAnnouncement(message);
                  toast.show(message, 'ok');
                } catch {
                  toast.show(t('memberContext.copyFailed'), 'error');
                }
              }}
            >
              {t('memberContext.copy')}
            </Button>
          </div>
        )}
      </div>
      {part === 'intro' && (
        <>
          {intro.map((section, index) => (
            <div key={section.id}>
              {index === (data.initialMessage ? 1 : 0) && (
                <>
                  <p className={`${styles.note} ${data.initialMessage ? styles.promptLead : ''}`}>
                    {t('memberContext.promptLead', { count: number(data.prompt.sections.length) })}
                  </p>
                  <p className={styles.note}>{t('memberContext.placementNote')}</p>
                </>
              )}
              <Fold
                summary={
                  <span lang={section.id === 'initialMessage' ? undefined : 'en'}>{section.title}</span>
                }
                peek={t('memberContext.chars', { count: number(section.chars) })}
                open={open.has(section.id)}
                onToggle={(value) => toggle(section.id, value)}
              >
                <pre lang="en" className={styles.text}>
                  {section.text}
                </pre>
              </Fold>
            </div>
          ))}
        </>
      )}
      {part === 'guides' && (
        <>
          <p className={styles.note}>{t('memberContext.guidesLead')}</p>
          {!data.guides.length && <p>{t('memberContext.noGuides')}</p>}
          {data.guides.map((guide) => (
            <Fold
              key={guide.topic}
              summary={
                <span lang="en">
                  {guide.title} · <code>{guide.topic}</code>
                </span>
              }
              peek={t('memberContext.chars', { count: number(guide.chars) })}
            >
              <pre lang="en" className={styles.text}>
                {guide.text}
              </pre>
            </Fold>
          ))}
        </>
      )}
      {part === 'tools' && (
        <>
          <label className={styles.filter}>
            {t('memberContext.toolsFilter')}
            <input value={filter} onChange={(event) => setFilter(event.target.value)} />
          </label>
          <p className={styles.note}>{t('memberContext.toolsNote')}</p>
          {!data.tools.length ? (
            <p>{t('memberContext.noTools')}</p>
          ) : !tools.length ? (
            <div>
              <p>{t('memberContext.noMatches', { filter })}</p>
              <Button variant="ghost" onClick={() => setFilter('')}>
                {t('memberContext.clearFilter')}
              </Button>
            </div>
          ) : (
            tools.map((tool) => (
              <Fold
                key={tool.name}
                summary={
                  <span lang="en">
                    <code>{tool.name}</code> · {tool.title}
                  </span>
                }
              >
                <pre lang="en" className={styles.text}>
                  {tool.description}
                </pre>
              </Fold>
            ))
          )}
        </>
      )}
      <span className={styles.srOnly} aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
