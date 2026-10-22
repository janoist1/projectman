import type { RedactionContext, SystemFeedbackItem } from '@projectman/shared';

/**
 * System feedback (PM-472, PM-479): the ports between the feedback service and the modules that must not
 * import it. The context is built fresh for every use, because names, members and paths change while the
 * server runs; it is never part of an answer, a log line or an error's details.
 */

/** What the filter must know about the installation, at this moment. */
export interface SystemFeedbackContextProvider {
  current(): Promise<RedactionContext>;
}

/** What the Operator's tools use to record a gap; the member is the one who found it. */
export interface SystemFeedbackRecorder {
  record(
    projectKey: string,
    member: string,
    sessionId: string,
    input: { title: string; what: string; workaround: string; fix: string; sameAs?: string },
  ): Promise<SystemFeedbackItem>;
}

/** Whether an item exists and belongs to the project (a synchronous read; PM-562 uses it). */
export interface SystemFeedbackLookup {
  belongsToProject(projectKey: string, id: string): boolean;
}
