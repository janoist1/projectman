import { useState } from 'react';
import type { Pipeline } from '@projectman/shared';
import { isApiError } from '../../../api/client';
import { useConfig, usePatchConfig } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { useToast } from '../../../components/toastContext';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';

/** One move of stages: the whole pipeline after it, saved at once. */
interface MoveRequest {
  pipeline: Pipeline;
  /** What moved (a stage or a column), for the messages. */
  name: string;
  /** The stages that move: they show "saving" meanwhile and the first one flashes after. */
  stageIds: string[];
  /** A column moves with its stages. */
  column?: boolean;
}

export interface PipelineMove {
  /** The pipeline being saved: the view shows it at once, the loaded configuration is untouched. */
  pending: { pipeline: Pipeline; stageIds: string[] } | null;
  /** True when the move was saved. */
  move(request: MoveRequest): Promise<boolean>;
}

/**
 * Saves a move of stages as one change with the loaded version, undoable like any settings save.
 * A conflict reloads the settings and does not repeat the move.
 */
export function usePipelineMove(onMoved: (stageId: string) => void): PipelineMove {
  const { key } = useProject();
  const query = useConfig(key);
  const patch = usePatchConfig(key);
  const toast = useToast();
  const [pending, setPending] = useState<PipelineMove['pending']>(null);

  const undoMove = async (version: string, before: Pipeline, request: MoveRequest) => {
    try {
      await patch.mutateAsync({ baseVersion: version, pipeline: before });
      toast.show(t('settings.pipeline.edit.undone', { name: request.name }));
      onMoved(request.stageIds[0]!);
    } catch (error) {
      if (isApiError(error) && error.code === 'config_conflict') {
        await query.refetch();
        toast.show(t('settings.pipeline.edit.undoConflict'), 'error');
      } else toast.show(errorMessage(error), 'error');
    }
  };

  const move = async (request: MoveRequest): Promise<boolean> => {
    const view = query.data;
    if (!view || pending) return false;
    setPending({ pipeline: request.pipeline, stageIds: request.stageIds });
    try {
      const result = await patch.mutateAsync({ baseVersion: view.version, pipeline: request.pipeline });
      toast.show(
        t(request.column ? 'settings.pipeline.move.movedColumn' : 'settings.pipeline.move.moved', {
          name: request.name,
        }),
        'ok',
        {
          action: {
            label: t('settings.pipeline.edit.undo'),
            // Only on the version this move made: a later save by anyone is not overwritten.
            run: () => void undoMove(result.version, view.config.pipeline, request),
          },
        },
      );
      onMoved(request.stageIds[0]!);
      return true;
    } catch (error) {
      if (isApiError(error) && error.code === 'config_conflict') {
        const fresh = (await query.refetch()).data;
        const author = fresh?.history[0]?.author;
        const name =
          fresh?.config.team.members.find((member) => member.handle === author)?.displayName ??
          (author || t('settings.pipeline.move.someone'));
        toast.show(t('settings.pipeline.move.conflict', { name }), 'error');
      } else
        toast.show(
          isApiError(error) && error.status > 0 && error.status < 500
            ? errorMessage(error)
            : t('settings.pipeline.move.failed', { name: request.name }),
          'error',
        );
      return false;
    } finally {
      setPending(null);
    }
  };

  return { pending, move };
}
