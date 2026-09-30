import { getLocale } from '@projectman/templates';
import { DUTY_IDS, DutyId, StageKind } from '@projectman/shared';
import type { Pipeline, ProjectConfig, Stage } from '@projectman/shared';
import { Button } from '../../../components/Button';
import { MemberSelect } from '../../../components/MemberSelect';
import { t } from '../../../i18n/t';
import { slugId } from '../../../lib/ids';
import shared from '../settings.module.css';

/** Changes one stage of the draft. */
export type StageUpdate = (update: (stage: Stage) => void) => void;

/** Stage and column ids follow the config's 32-character, lowercase underscore format. */
export function pipelineId(name: string, ids: string[]): string {
  return slugId(name, ids, { separator: '_', maxLength: 32, letterPrefix: 'stage_' });
}

/** A stage's name, kind, board column and description. */
export function StageFields({
  stage,
  pipeline,
  update,
}: {
  stage: Stage;
  pipeline: Pipeline;
  update: StageUpdate;
}) {
  return (
    <>
      <label className={shared.field}>
        {t('settings.project.name')}
        <input
          value={stage.name}
          onChange={(event) =>
            update((draft) => {
              draft.name = event.target.value;
            })
          }
        />
      </label>
      <label className={shared.field}>
        {t('settings.pipeline.kindLabel')}
        <select
          value={stage.kind}
          onChange={(event) =>
            update((draft) => {
              draft.kind = StageKind.parse(event.target.value);
            })
          }
        >
          {StageKind.options.map((kind) => (
            <option key={kind} value={kind}>
              {t(`stageKinds.${kind}`)} — {t(`settings.pipeline.kindHelp.${kind}`)}
            </option>
          ))}
        </select>
      </label>
      <p className={shared.muted}>{t(`settings.pipeline.kindHelp.${stage.kind}`)}</p>
      <label className={shared.field}>
        {t('settings.pipeline.column')}
        <select
          value={stage.columnId}
          onChange={(event) =>
            update((draft) => {
              draft.columnId = event.target.value;
            })
          }
        >
          {pipeline.columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
        </select>
      </label>
      <label className={shared.field}>
        {t('settings.edit.description')}
        <textarea
          value={stage.description ?? ''}
          onChange={(event) =>
            update((draft) => {
              draft.description = event.target.value;
            })
          }
        />
      </label>
    </>
  );
}

/** Who owns a stage: its duty's holders, or members picked by name. */
export function StageOwners({
  stage,
  config,
  update,
}: {
  stage: Stage;
  config: ProjectConfig;
  update: StageUpdate;
}) {
  return (
    <>
      <label className={shared.field}>
        {t('duties.duty')}
        <select
          value={stage.duty ?? ''}
          onChange={(event) =>
            update((draft) => {
              draft.duty = event.target.value ? DutyId.parse(event.target.value) : undefined;
              delete draft.owners;
            })
          }
        >
          <option value="">{t('duties.explicitOwners')}</option>
          {DUTY_IDS.map((id) => (
            <option key={id} value={id}>
              {getLocale(config.project.language).duties[id].name}
            </option>
          ))}
        </select>
      </label>
      <p className={shared.muted}>
        {t(
          stage.duty && stage.owners === undefined
            ? 'settings.pipeline.dutyOwners'
            : 'settings.pipeline.explicitOwners',
        )}
      </p>
      {stage.duty && (
        <Button
          variant="secondary"
          onClick={() =>
            update((draft) => {
              delete draft.owners;
            })
          }
        >
          {t('duties.defaultOwners')}
        </Button>
      )}
      <MemberSelect
        label={t('settings.pipeline.owners')}
        members={config.team.members}
        value={stage.owners ?? []}
        onChange={(owners) =>
          update((draft) => {
            draft.owners = owners;
          })
        }
      />
    </>
  );
}
