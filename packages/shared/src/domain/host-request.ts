import { z } from 'zod';
import { hostOutsideOwners } from '../config/lookup';
import { coordinationActorRefusal } from '../config/project-manager';
import type { ProjectConfig } from '../config/schema';

/** A request the project manager opens to the instance's host (PM-1064); only the host answers it. */
export const HostRequestState = z.enum(['open', 'answered', 'declined', 'withdrawn']);
export type HostRequestState = z.infer<typeof HostRequestState>;

/** How the host closes a request. */
export const HostRequestOutcome = z.enum(['answered', 'declined']);
export type HostRequestOutcome = z.infer<typeof HostRequestOutcome>;

/** At most this many open requests per project; closed ones do not count. */
export const HOST_REQUEST_OPEN_LIMIT = 5;

export const HostRequestTitle = z.string().trim().min(1).max(120);
export const HostRequestBody = z.string().trim().min(1).max(4000);

/**
 * What the host sees of a request: the text and where it comes from, never a card, a message or the project's
 * content (so no `taskKey`).
 */
export const HostRequestView = z.object({
  id: z.string(),
  projectKey: z.string(),
  projectName: z.string(),
  /** The handle of the project manager who opened it. */
  openedBy: z.string(),
  /** The names of the project's human owners. */
  owners: z.array(z.string()),
  title: z.string(),
  body: z.string(),
  state: HostRequestState,
  answer: z.string().nullable(),
  answeredVia: z.enum(['web', 'super']).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HostRequestView = z.infer<typeof HostRequestView>;

export const HostRequestListResponse = z.object({ requests: z.array(HostRequestView) });
export type HostRequestListResponse = z.infer<typeof HostRequestListResponse>;

export const AnswerHostRequestRequest = z.object({
  outcome: HostRequestOutcome,
  answer: z.string().trim().min(1).max(4000),
});
export type AnswerHostRequestRequest = z.infer<typeof AnswerHostRequestRequest>;

/**
 * Why the member may not open a request to the host, or null when it may: only the selected project manager,
 * and only in a project the host is not an owner of (an owner asks the host through their own rights).
 */
export function hostRequestRefusal(
  config: Pick<ProjectConfig, 'team'>,
  handle: string,
  hostEmail: string | null,
): 'project_manager_only' | 'host_request_not_needed' | null {
  if (coordinationActorRefusal(config, { kind: 'ai', handle, via: undefined }) !== null) {
    return 'project_manager_only';
  }
  if (!hostOutsideOwners(config, hostEmail)) return 'host_request_not_needed';
  return null;
}
