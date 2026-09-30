import { useState } from 'react';
import type { LabelDefinition } from '@projectman/shared';
import { useBoard } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { LabelChip } from '../../components/LabelChip';
import { t } from '../../i18n/t';
import { LabelCard, labelId } from './labels/LabelCard';
import type { SectionEditorProps } from './SettingsEditor';
import shared from './settings.module.css';

/**
 * The project's labels: what each means and who may set it. Gates refer to labels by id, so an
 * existing label keeps its id; tags used on tasks without a definition can be given one here.
 */
export function LabelsEditor({
  draft,
  change,
  isOwner,
}: Pick<SectionEditorProps, 'draft' | 'change' | 'isOwner'>) {
  const { key } = useProject();
  const board = useBoard(key);
  const [open, setOpen] = useState<string | null>(null);
  // Labels added in this edit: their id follows their name until saved.
  const [fresh, setFresh] = useState<string[]>([]);
  const labels = draft.pipeline.labels;
  const counts = new Map<string, number>();
  for (const task of board.data?.tasks ?? [])
    for (const tag of task.labels) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const undefinedTags = [...counts].filter(([tag]) => !labels.some((label) => label.id === tag));
  const add = (label: LabelDefinition) => {
    change((config) => void config.pipeline.labels.push(label));
    setOpen(label.id);
  };

  return (
    <fieldset className={shared.conditions}>
      <legend>{t('settings.labels.title')}</legend>
      {labels.map((label, index) => (
        <LabelCard
          key={label.id}
          draft={draft}
          index={index}
          isOwner={isOwner}
          open={open === label.id}
          onToggle={() => setOpen(open === label.id ? null : label.id)}
          followsName={fresh.includes(label.id)}
          onIdChange={(from, to) => {
            setFresh((ids) => ids.map((value) => (value === from ? to : value)));
            setOpen(to);
          }}
          change={change}
        />
      ))}
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
        <div className={shared.condition}>
          <p className={shared.muted}>{t('settings.labels.undefinedTitle')}</p>
          {undefinedTags.map(([tag, count]) => (
            <div key={tag} className={shared.stageTop}>
              <LabelChip id={tag} labels={[]} />
              <span className={shared.muted}>{t('settings.labels.onTasks', { count })}</span>
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
