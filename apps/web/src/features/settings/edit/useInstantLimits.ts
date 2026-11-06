import {
  complexitySettersOf,
  PrioritySetter,
  prioritySettersOf,
  projectManagerAuthorityOf,
  ProjectManagerLifecycleAction,
  projectManagerLifecycleOf,
  taskCreateAccessOf,
  DEFAULT_OWNER_DECISION_TOPICS,
} from '@projectman/shared';
import type { ProjectConfig, PatchConfigRequest } from '@projectman/shared';
import { isApiError } from '../../../api/client';
import { useToast } from '../../../components/toastContext';
import { t } from '../../../i18n/t';
import type { IssueRef } from '../../../lib/configIssues';
import { errorMessage } from '../../../lib/errors';
import { useSettingsEditing } from './SettingsEditing';
import { useInstantConfig } from './useInstantConfig';

/**
 * The limits part of the configuration, as the limits section saves it, and what else saves the moment
 * it changes: who merges, and which repositories require a merge (PM-453). Those two go only where they
 * differ from the saved configuration, the merger as the kind chosen and a repository's value as
 * true, false or null (the project's default applies).
 */
function limitsBody(draft: ProjectConfig, saved: ProjectConfig, baseVersion: string): PatchConfigRequest {
  const repoMerge = draft.project.repos.flatMap((repo) => {
    const before = saved.project.repos.find((entry) => entry.name === repo.name)?.requireMerge ?? null;
    const requireMerge = repo.requireMerge ?? null;
    return requireMerge === before ? [] : [{ repo: repo.name, requireMerge }];
  });
  const merger =
    draft.team.merger && JSON.stringify(draft.team.merger) !== JSON.stringify(saved.team.merger)
      ? draft.team.merger
      : null;
  const cardMover =
    draft.team.cardMover && JSON.stringify(draft.team.cardMover) !== JSON.stringify(saved.team.cardMover)
      ? draft.team.cardMover
      : null;
  const projectManagerMoves =
    draft.team.projectManagerMoves !== saved.team.projectManagerMoves
      ? draft.team.projectManagerMoves
      : undefined;
  // The lifecycle actions go as the whole list when it differs from the saved one (PM-1098); [] is a value.
  const lifecycleOf = (config: ProjectConfig) => {
    const chosen = projectManagerLifecycleOf(config);
    return ProjectManagerLifecycleAction.options.filter((action) => chosen.includes(action));
  };
  const projectManagerLifecycle = lifecycleOf(draft);
  const lifecycleChanged = JSON.stringify(projectManagerLifecycle) !== JSON.stringify(lifecycleOf(saved));
  const prerequisiteOverride =
    draft.team.prerequisiteOverride !== saved.team.prerequisiteOverride
      ? draft.team.prerequisiteOverride
      : undefined;
  // The project manager's authority goes only when it differs from the saved value (PM-1284); owner-only on the server.
  const projectManagerAuthority =
    projectManagerAuthorityOf(draft) !== projectManagerAuthorityOf(saved)
      ? projectManagerAuthorityOf(draft)
      : undefined;
  // The priority setters go as the whole list when it changed, [] too; compared in the options' order.
  const settersOf = (config: ProjectConfig) => {
    const chosen = prioritySettersOf(config);
    return PrioritySetter.options.filter((setter) => chosen.includes(setter));
  };
  const prioritySetters = settersOf(draft);
  const prioritySettersChanged = JSON.stringify(prioritySetters) !== JSON.stringify(settersOf(saved));
  const viewerRecipients =
    draft.team.viewerRecipients !== saved.team.viewerRecipients ? draft.team.viewerRecipients : undefined;
  // Who may open a new card goes only when it differs from the saved value (PM-1100); owner-only on the server.
  const taskCreateAccess =
    taskCreateAccessOf(draft) !== taskCreateAccessOf(saved) ? taskCreateAccessOf(draft) : undefined;
  // The complexity setters go as the whole list when it differs from the saved one (PM-1097); [] is a value.
  const complexitySetters = complexitySettersOf(draft);
  const complexityChanged = JSON.stringify(complexitySetters) !== JSON.stringify(complexitySettersOf(saved));
  // The assignee-fit choice goes only when it differs from the saved one (PM-1137); a missing value is the default.
  const assigneeFit =
    (draft.team.assigneeFit ?? 'automatic') !== (saved.team.assigneeFit ?? 'automatic')
      ? (draft.team.assigneeFit ?? 'automatic')
      : undefined;
  // The contacts go as the whole list when it changed, an empty one too: a missing field keeps the stored list.
  const contacts = draft.team.contacts ?? [];
  const contactsChanged = JSON.stringify(contacts) !== JSON.stringify(saved.team.contacts ?? []);
  // A removed cap or warning limit is sent as null: a missing field would leave the stored one as it is.
  return {
    baseVersion,
    ...(merger ? { merger } : {}),
    ...(cardMover ? { cardMover } : {}),
    ...(taskCreateAccess ? { taskCreateAccess } : {}),
    ...(projectManagerMoves ? { projectManagerMoves } : {}),
    ...(lifecycleChanged ? { projectManagerLifecycle } : {}),
    ...(prerequisiteOverride ? { prerequisiteOverride } : {}),
    ...(projectManagerAuthority ? { projectManagerAuthority } : {}),
    ...(prioritySettersChanged ? { prioritySetters } : {}),
    ...(complexityChanged ? { complexitySetters: [...complexitySetters] } : {}),
    ...(contactsChanged ? { contacts } : {}),
    ...(JSON.stringify(draft.team.ownerDecisionTopics ?? DEFAULT_OWNER_DECISION_TOPICS) !==
    JSON.stringify(saved.team.ownerDecisionTopics ?? DEFAULT_OWNER_DECISION_TOPICS)
      ? { ownerDecisionTopics: draft.team.ownerDecisionTopics ?? [...DEFAULT_OWNER_DECISION_TOPICS] }
      : {}),
    ...(viewerRecipients ? { viewerRecipients } : {}),
    ...(assigneeFit ? { assigneeFit } : {}),
    ...(repoMerge.length ? { repoMerge } : {}),
    limits: {
      ...draft.team.limits,
      maxConcurrentAi: draft.team.limits.maxConcurrentAi ?? null,
      warnAboveSessionTokens: draft.team.limits.warnAboveSessionTokens ?? null,
      autoCompactWindowTokens: draft.team.limits.autoCompactWindowTokens ?? null,
    },
    ...(draft.team.boundary ? { boundary: draft.team.boundary } : {}),
  };
}

/**
 * The limits save the moment a control changes (see `useInstantConfig`). A refusal is also a toast, as
 * the control may be off screen (a phone), except where the control itself shows the field's error
 * (the merger, the card mover): the toast would cover it. A version conflict also reloads the configuration.
 */
export function useInstantLimits(config: ProjectConfig) {
  const context = useSettingsEditing();
  const toast = useToast();
  const reload = context?.reload;
  const instant = useInstantConfig(config, {
    body: (next, saved) => limitsBody(next, saved.config, saved.version),
    saved: () => toast.show(t('settings.edit.saved')),
    refused: async (caught) => {
      const conflict = isApiError(caught) && caught.code === 'config_conflict';
      const atField =
        isApiError(caught) &&
        (caught.details as { issues?: IssueRef[] } | undefined)?.issues?.some(
          (issue) =>
            issue.code === 'merger_unresolved' ||
            issue.code.startsWith('mover_') ||
            /^(team\.)?ownerDecisionTopics/.test(issue.path),
        );
      if (!atField) toast.show(conflict ? t('settings.limits.conflict') : errorMessage(caught), 'error');
      if (conflict) await reload?.();
    },
  });
  // A saved change moves the version on: the save of an element edit that is open would be a conflict.
  const locked = context?.unsaved === true;
  return {
    shown: instant.shown,
    saving: instant.saving,
    commit: instant.commit,
    error: instant.error,
    locked,
  };
}
