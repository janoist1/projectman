import { useState } from 'react';
import { DUTY_IDS, isHumanOnlyLabel, LabelColor } from '@projectman/shared';
import type { DutyId, LabelDefinition, LabelSetBy, ProjectConfig } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { useBoard } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { LabelChip } from '../../components/LabelChip';
import { t } from '../../i18n/t';
import { MemberSelect } from './PipelineEditor';
import styles from './SettingsPage.module.css';

type Who = 'anyone' | 'humans' | 'system' | 'duties' | 'members';

function whoOf(setBy: LabelSetBy): Who {
  if (typeof setBy === 'string') return setBy;
  return setBy.duties?.length ? 'duties' : 'members';
}

/** A label id from its name: lowercase ascii words joined by dashes, unique in the project. */
function labelId(name: string, taken: string[]): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'label';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * The project's labels: what each means and who may set it. Gates refer to labels by id, so an
 * existing label keeps its id; tags used on tasks without a definition can be given one here.
 */
export function LabelsEditor({
  draft,
  change,
  isOwner,
}: {
  draft: ProjectConfig;
  change: (update: (draft: ProjectConfig) => void) => void;
  isOwner: boolean;
}) {
  const { key } = useProject();
  const board = useBoard(key);
  const [open, setOpen] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);
  const labels = draft.pipeline.labels;
  const humans = draft.team.members.filter((member) => member.kind === 'human');
  const duties = getLocale(draft.project.language).duties;
  const usedBy = (id: string) =>
    draft.pipeline.stages.filter((stage) => stage.gate?.conditions.some((c) => c.label === id));
  const counts = new Map<string, number>();
  for (const task of board.data?.tasks ?? [])
    for (const tag of task.labels) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const undefinedTags = [...counts].filter(([tag]) => !labels.some((label) => label.id === tag));
  const add = (label: LabelDefinition) => {
    change((config) => void config.pipeline.labels.push(label));
    setOpen(label.id);
  };
  const edit = (index: number, update: (label: LabelDefinition) => void) =>
    change((config) => update(config.pipeline.labels[index]!));

  return (
    <fieldset className={styles.conditions}>
      <legend>{t('settings.labels.title')}</legend>
      {labels.map((label, index) => {
        // Approvals (labels only humans may set) are the owner's to change.
        const locked = isHumanOnlyLabel(label) && !isOwner;
        const who = whoOf(label.setBy);
        const gates = usedBy(label.id);
        const setWho = (next: Who) =>
          edit(index, (entry) => {
            const humansOnly = typeof entry.setBy === 'object' ? entry.setBy.humansOnly : undefined;
            entry.setBy =
              next === 'duties'
                ? { duties: ['code_review'], ...(humansOnly ? { humansOnly } : {}) }
                : next === 'members'
                  ? {
                      members: humans.map((m) => m.handle).slice(0, 1),
                      ...(humansOnly ? { humansOnly } : {}),
                    }
                  : next;
          });
        const flag = (field: 'notByAuthor' | 'requiresComment' | 'notifyAssignee' | 'blocks') => (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={label[field] === true}
              disabled={locked}
              onChange={(event) =>
                edit(index, (entry) => {
                  if (event.target.checked) entry[field] = true;
                  else delete entry[field];
                })
              }
            />
            {t(`settings.labels.${field}`)}
          </label>
        );
        return (
          <div key={label.id} className={styles.stage}>
            <div className={styles.stageTop}>
              <LabelChip id={label.id} labels={labels.map((l) => ({ ...l, holders: [] }))} />
              <code className={styles.id}>{label.id}</code>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOpen(open === label.id ? null : label.id)}
              >
                {t(open === label.id ? 'settings.labels.close' : 'settings.labels.edit')}
              </Button>
            </div>
            {open === label.id ? (
              <div className={styles.condition}>
                {locked ? <p className={styles.muted}>{t('settings.edit.approvalOwnerOnly')}</p> : null}
                <label className={styles.field}>
                  {t('settings.labels.name')}
                  <input
                    value={label.name}
                    disabled={locked}
                    onChange={(event) =>
                      change((config) => {
                        const entry = config.pipeline.labels[index]!;
                        entry.name = event.target.value;
                        // A label nothing uses yet takes its id from the name.
                        if (fresh.includes(entry.id)) {
                          const id = labelId(
                            event.target.value,
                            config.pipeline.labels.filter((_, i) => i !== index).map((l) => l.id),
                          );
                          setFresh((ids) => ids.map((value) => (value === entry.id ? id : value)));
                          setOpen(id);
                          entry.id = id;
                        }
                      })
                    }
                  />
                </label>
                <label className={styles.field}>
                  {t('settings.labels.meaning')}
                  <textarea
                    rows={2}
                    value={label.meaning ?? ''}
                    disabled={locked}
                    onChange={(event) => edit(index, (entry) => void (entry.meaning = event.target.value))}
                  />
                </label>
                <label className={styles.field}>
                  {t('settings.labels.color')}
                  <select
                    value={label.color ?? ''}
                    disabled={locked}
                    onChange={(event) =>
                      edit(index, (entry) => {
                        if (event.target.value) entry.color = LabelColor.parse(event.target.value);
                        else delete entry.color;
                      })
                    }
                  >
                    <option value="">{t('settings.labels.noColor')}</option>
                    {LabelColor.options.map((color) => (
                      <option key={color} value={color}>
                        {t(`columnColors.${color}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  {t('settings.labels.group')}
                  <input
                    value={label.group ?? ''}
                    disabled={locked}
                    placeholder={t('settings.labels.groupHint')}
                    onChange={(event) =>
                      edit(index, (entry) => {
                        const group = labelId(event.target.value, []);
                        if (event.target.value.trim()) entry.group = group;
                        else delete entry.group;
                      })
                    }
                  />
                </label>
                <label className={styles.field}>
                  {t('settings.labels.who')}
                  <select
                    value={who}
                    disabled={locked}
                    onChange={(event) => setWho(event.target.value as Who)}
                  >
                    {(['anyone', 'humans', 'duties', 'members', 'system'] as const).map((option) => (
                      <option key={option} value={option}>
                        {t(`settings.labels.whoOptions.${option}`)}
                      </option>
                    ))}
                  </select>
                </label>
                {who === 'duties' && typeof label.setBy === 'object' ? (
                  <label className={styles.field}>
                    {t('duties.duty')}
                    <select
                      multiple
                      value={label.setBy.duties ?? []}
                      disabled={locked}
                      onChange={(event) =>
                        edit(index, (entry) => {
                          const picked = Array.from(event.target.selectedOptions, (o) => o.value as DutyId);
                          if (typeof entry.setBy === 'object' && picked.length) entry.setBy.duties = picked;
                        })
                      }
                    >
                      {DUTY_IDS.map((id) => (
                        <option key={id} value={id}>
                          {duties[id].name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {who === 'members' && typeof label.setBy === 'object' ? (
                  <MemberSelect
                    label={t('settings.labels.members')}
                    members={draft.team.members}
                    value={label.setBy.members ?? []}
                    disabled={locked}
                    onChange={(handles) =>
                      edit(index, (entry) => {
                        if (typeof entry.setBy === 'object' && handles.length) entry.setBy.members = handles;
                      })
                    }
                  />
                ) : null}
                {typeof label.setBy === 'object' ? (
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={label.setBy.humansOnly === true}
                      disabled={!isOwner}
                      onChange={(event) =>
                        edit(index, (entry) => {
                          if (typeof entry.setBy !== 'object') return;
                          if (event.target.checked) entry.setBy.humansOnly = true;
                          else delete entry.setBy.humansOnly;
                        })
                      }
                    />
                    {t('settings.labels.humansOnly')}
                  </label>
                ) : null}
                {flag('notByAuthor')}
                {flag('requiresComment')}
                {flag('notifyAssignee')}
                {flag('blocks')}
                {(['moved_back', 'pr_updated'] as const).map((trigger) => (
                  <label key={trigger} className={styles.check}>
                    <input
                      type="checkbox"
                      checked={label.clearedWhen?.includes(trigger) === true}
                      disabled={locked}
                      onChange={(event) =>
                        edit(index, (entry) => {
                          const next = new Set(entry.clearedWhen ?? []);
                          if (event.target.checked) next.add(trigger);
                          else next.delete(trigger);
                          if (next.size) entry.clearedWhen = [...next];
                          else delete entry.clearedWhen;
                        })
                      }
                    />
                    {t(`settings.labels.clearedWhen.${trigger}`)}
                  </label>
                ))}
                {gates.length > 0 ? (
                  <p className={styles.muted}>
                    {t('settings.labels.usedByGates', {
                      stages: gates.map((stage) => stage.name).join(', '),
                    })}
                  </p>
                ) : null}
                <Button
                  variant="danger"
                  disabled={locked || gates.length > 0}
                  onClick={() => change((config) => void config.pipeline.labels.splice(index, 1))}
                >
                  {t('settings.labels.remove')}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
      <Button
        variant="secondary"
        onClick={() => {
          const id = labelId(
            t('settings.labels.newName'),
            labels.map((l) => l.id),
          );
          setFresh((ids) => [...ids, id]);
          add({ id, name: t('settings.labels.newName'), setBy: 'anyone' });
        }}
      >
        {t('settings.labels.add')}
      </Button>
      {undefinedTags.length > 0 ? (
        <div className={styles.condition}>
          <p className={styles.muted}>{t('settings.labels.undefinedTitle')}</p>
          {undefinedTags.map(([tag, count]) => (
            <div key={tag} className={styles.stageTop}>
              <LabelChip id={tag} labels={[]} />
              <span className={styles.muted}>{t('settings.labels.onTasks', { count })}</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => add({ id: tag, name: tag, setBy: 'anyone' })}
              >
                {t('settings.labels.define')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}
