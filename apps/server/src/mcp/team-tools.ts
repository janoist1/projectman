import type { SentMessageRecipient } from '../contracts';
import type { WorkItemRef } from '@projectman/shared';
import type {
  InboxToolsHandler,
  MessageToolsHandler,
  AdmissionToolsHandler,
  WatcherToolsHandler,
  SessionToolsHandler,
  MemberToolsHandler,
  TaskToolsHandler,
  AttachmentToolsHandler,
  ScreenshotToolsHandler,
  MergeToolsHandler,
  FeedbackToolsHandler,
  GithubToolsHandler,
  BoundaryToolsHandler,
  ReleaseToolsHandler,
  OperatorToolsHandler,
  ProjectDocToolsHandler,
  AttachmentPage,
  ListTasksInput,
  LocatedAttachmentForTool,
  MessageAttachmentReading,
  ProposedRelease,
  ReleaseCheckResult,
  ScreenshotRun,
  MemberStartResult,
  TakeScreenshotsInput,
  TaskSummary,
  TaskToolDetail,
  TeamToolsHandler,
  ToolContext,
  ProjectDocRead,
  ProjectDocWrite,
} from '../contracts';
import type {
  Attachment,
  MemberView,
  QuestionAttachment,
  QuestionOptionInput,
  ScreeningOutcome,
  Task,
  TaskKind,
  TaskPriority,
  Visibility,
  WorkDoing,
  AddRelationRef,
  DeveloperLevelRequest,
  RelationsChange,
  SubmitBoundaryRequest,
  DecideBoundaryRequest,
  OperatorPreferenceData,
  ProposeOperatorKnowledgeRequest,
  ProjectDoc,
  QuestionTodo,
} from '@projectman/shared';

/**
 * The team tools behind the MCP server (mcp__team__*): they check the arguments, call the
 * domain services and put their refusals in words the agent reads. Every action is attributed
 * to the calling AI member.
 * Module handlers are collected through forwarding methods; new tools belong in their module's
 * mcp/<module>/handler.ts, never in this collector.
 */
export class TeamToolsService implements TeamToolsHandler {
  async getOperatorPreference(ctx: ToolContext) {
    return this.tools.operator.getOperatorPreference(ctx);
  }
  async getOperatorKnowledge(ctx: ToolContext) {
    return this.tools.operator.getOperatorKnowledge(ctx);
  }
  async proposeOperatorKnowledge(ctx: ToolContext, args: ProposeOperatorKnowledgeRequest) {
    return this.tools.operator.proposeOperatorKnowledge(ctx, args);
  }
  async setOperatorPreference(
    ctx: ToolContext,
    args: { expectedRevision: number; preference: OperatorPreferenceData },
  ) {
    return this.tools.operator.setOperatorPreference(ctx, args);
  }
  private readonly tools: {
    members: MemberToolsHandler;
    tasks: TaskToolsHandler;
    attachments: AttachmentToolsHandler;
    merges: MergeToolsHandler;
    feedback: FeedbackToolsHandler;
    github: GithubToolsHandler;
    screenshots: ScreenshotToolsHandler;
    boundary: BoundaryToolsHandler;
    releases: ReleaseToolsHandler;
    operator: OperatorToolsHandler;
    projectDocs: ProjectDocToolsHandler;
    inbox: InboxToolsHandler;
    messages: MessageToolsHandler;
    admission: AdmissionToolsHandler;
    watchers: WatcherToolsHandler;
    sessions: SessionToolsHandler;
  };

  async getOperatorDiagnostics(ctx: ToolContext, args: { taskKey: string; limit?: number }) {
    return this.tools.operator.getOperatorDiagnostics(ctx, args);
  }

  async getProjectState(ctx: ToolContext, args: { taskKey?: string; messageId?: string }) {
    return this.tools.operator.getProjectState(ctx, args);
  }
  async submitBoundaryRequest(ctx: ToolContext, args: SubmitBoundaryRequest) {
    return this.tools.boundary.submitBoundaryRequest(ctx, args);
  }
  async getBoundaryRequest(ctx: ToolContext, args: { requestId: string }) {
    return this.tools.boundary.getBoundaryRequest(ctx, args);
  }
  async decideBoundaryRequest(ctx: ToolContext, args: DecideBoundaryRequest & { requestId: string }) {
    return this.tools.boundary.decideBoundaryRequest(ctx, args);
  }
  async decidePermissionRequest(
    ctx: ToolContext,
    args: { requestId: string; decision: 'allow' | 'deny' | 'escalate'; reason: string },
  ) {
    return this.tools.inbox.decidePermissionRequest(ctx, args);
  }
  async decideFixLimit(
    ctx: ToolContext,
    args: { taskKey: string; decision: 'continue' | 'replan' | 'to_owner'; reason: string },
  ) {
    return this.tools.watchers.decideFixLimit(ctx, args);
  }
  async handOff(ctx: ToolContext, args: { taskKey: string; note: string }): Promise<{ recorded: true }> {
    return this.tools.admission.handOff(ctx, args);
  }
  constructor(deps: {
    tools: {
      members: MemberToolsHandler;
      tasks: TaskToolsHandler;
      attachments: AttachmentToolsHandler;
      merges: MergeToolsHandler;
      feedback: FeedbackToolsHandler;
      github: GithubToolsHandler;
      screenshots: ScreenshotToolsHandler;
      boundary: BoundaryToolsHandler;
      releases: ReleaseToolsHandler;
      operator: OperatorToolsHandler;
      projectDocs: ProjectDocToolsHandler;
      inbox: InboxToolsHandler;
      messages: MessageToolsHandler;
      admission: AdmissionToolsHandler;
      watchers: WatcherToolsHandler;
      sessions: SessionToolsHandler;
    };
  }) {
    this.tools = deps.tools;
  }

  async sendMessage(
    ctx: ToolContext,
    args: {
      to: string[];
      text: string;
      taskKey?: string;
      kind: 'action' | 'info';
      despiteWorkers?: boolean;
      signalId?: string;
      signalActionable?: boolean;
      signalIds?: string[];
      actionableSignalIds?: string[];
      /** Paths of files of the caller's session folder or working directory (PM-520). */
      attachments?: string[];
    },
  ): Promise<{
    messageId: string;
    deliveredTo: string[];
    recipients: SentMessageRecipient[];
    routed?: { handle: string; workItem: WorkItemRef }[];
    operator: boolean;
  }> {
    return this.tools.messages.sendMessage(ctx, args);
  }
  async listMembers(ctx: ToolContext): Promise<MemberView[]> {
    return this.tools.members.listMembers(ctx);
  }

  async listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]> {
    return this.tools.tasks.listTasks(ctx, args);
  }

  async getTask(ctx: ToolContext, args: { taskKey: string; eventId?: string }): Promise<TaskToolDetail> {
    return this.tools.tasks.getTask(ctx, args);
  }

  async listAttachments(
    ctx: ToolContext,
    args: { taskKey: string; offset?: number; limit?: number },
  ): Promise<AttachmentPage> {
    return this.tools.attachments.listAttachments(ctx, args);
  }

  async readAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<LocatedAttachmentForTool> {
    return this.tools.attachments.readAttachment(ctx, args);
  }

  async readMessageAttachment(
    ctx: ToolContext,
    args: { attachmentId: string },
  ): Promise<MessageAttachmentReading> {
    return this.tools.attachments.readMessageAttachment(ctx, args);
  }

  // ---- feedback marks (PM-512, processors only) ----

  async getFeedbackList(ctx: ToolContext, args: { status: 'todo' | 'open' | 'all'; limit: number }) {
    return this.tools.feedback.getFeedbackList(ctx, args);
  }

  async getFeedbackMark(ctx: ToolContext, args: { markId: string }) {
    return this.tools.feedback.getFeedbackMark(ctx, args);
  }

  async replyFeedback(ctx: ToolContext, args: { markId: string; body: string }) {
    return this.tools.feedback.replyFeedback(ctx, args);
  }

  async createTaskFromFeedback(
    ctx: ToolContext,
    args: { markId: string; title: string; description: string; visibility?: Visibility; reply?: string },
  ) {
    return this.tools.feedback.createTaskFromFeedback(ctx, args);
  }

  async linkFeedback(ctx: ToolContext, args: { markId: string; taskKey: string; reply?: string }) {
    return this.tools.feedback.linkFeedback(ctx, args);
  }

  async forwardFeedback(ctx: ToolContext, args: { markId: string; reason: string; reply: string }) {
    return this.tools.feedback.forwardFeedback(ctx, args);
  }

  async closeFeedback(ctx: ToolContext, args: { markId: string; reply?: string }) {
    return this.tools.feedback.closeFeedback(ctx, args);
  }

  async attachFile(
    ctx: ToolContext,
    args: { taskKey: string; path: string },
  ): Promise<{ attachment: Attachment }> {
    return this.tools.attachments.attachFile(ctx, args);
  }

  async takeScreenshots(ctx: ToolContext, input: TakeScreenshotsInput): Promise<ScreenshotRun> {
    return this.tools.screenshots.takeScreenshots(ctx, input);
  }

  async getScreenshotRun(ctx: ToolContext, runId: string): Promise<ScreenshotRun> {
    return this.tools.screenshots.getScreenshotRun(ctx, runId);
  }

  async deleteAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<{ attachmentId: string; fileName: string | null }> {
    return this.tools.attachments.deleteAttachment(ctx, args);
  }

  async mergeTask(
    ctx: ToolContext,
    args: { taskKey: string; fixConflict?: boolean; resolution?: string },
  ): Promise<{ task: Task }> {
    return this.tools.merges.mergeTask(ctx, args);
  }

  async prioritizeMerge(
    ctx: ToolContext,
    args: { taskKey: string; reason: string },
  ): Promise<{ task: Task; moved: boolean }> {
    return this.tools.merges.prioritizeMerge(ctx, args);
  }

  async proposeRelease(
    ctx: ToolContext,
    args: { title: string; summary: string; commit?: string; preview?: boolean },
  ): Promise<ProposedRelease> {
    return this.tools.releases.proposeRelease(ctx, args);
  }

  async checkRelease(ctx: ToolContext, args: { commit?: string }): Promise<ReleaseCheckResult> {
    return this.tools.releases.checkRelease(ctx, args);
  }

  async updateTask(
    ctx: ToolContext,
    args: {
      taskKey: string;
      stageId?: string;
      addLabels?: string[];
      removeLabels?: string[];
      note?: string;
      title?: string;
      description?: string;
      repo?: string | null;
      relations?: RelationsChange;
      themeKey?: string | null;
      priority?: TaskPriority | null;
      developerLevel?: DeveloperLevelRequest;
    },
  ): Promise<{ task: Task }> {
    return this.tools.tasks.updateTask(ctx, args);
  }

  async createTask(
    ctx: ToolContext,
    args: {
      title: string;
      description?: string;
      labels?: string[];
      visibility?: Visibility;
      parentKey?: string;
      relations?: AddRelationRef[];
      kind?: TaskKind;
      themeKey?: string;
      developerLevel?: DeveloperLevelRequest;
    },
  ): Promise<{ task: Task }> {
    return this.tools.tasks.createTask(ctx, args);
  }

  async linkPullRequest(
    ctx: ToolContext,
    args: { taskKey: string; repo: string; number: number },
  ): Promise<{ task: Task }> {
    return this.tools.github.linkPullRequest(ctx, args);
  }

  async askHuman(
    ctx: ToolContext,
    args: {
      question: string;
      options?: QuestionOptionInput[];
      taskKey?: string;
      to?: string[];
      recommended?: string;
      recommendationReason?: string;
      details?: string;
      attachmentIds?: string[];
      /** The question asked again after the Operator screened it away (PM-558), and why a person must see it. */
      reaskOf?: string;
      reaskReason?: string;
    },
  ): Promise<{
    inboxItemId: string;
    approvalLabel?: string;
    attachments?: QuestionAttachment[];
    screening?: true;
  }> {
    return this.tools.inbox.askHuman(ctx, args);
  }

  async combineQuestions(ctx: ToolContext, args: { itemIds: string[]; question: string; note: string }) {
    return this.tools.operator.combineQuestions(ctx, args);
  }

  async screenQuestion(
    ctx: ToolContext,
    args: {
      itemId: string;
      outcome: ScreeningOutcome;
      note: string;
      answer?: string;
      forwardTo?: string;
      todo?: QuestionTodo;
    },
  ): Promise<{ inboxItemId: string; outcome: ScreeningOutcome }> {
    return this.tools.operator.screenQuestion(ctx, args);
  }

  async saveMemory(ctx: ToolContext, args: { note: string }): Promise<{ ok: true }> {
    return this.tools.members.saveMemory(ctx, args);
  }
  async dismissSignal(
    ctx: ToolContext,
    args: { signalId: string; note: string },
  ): Promise<{ signalId: string; state: 'dismissed' }> {
    return this.tools.operator.dismissSignal(ctx, args);
  }
  async withdrawQuestion(
    ctx: ToolContext,
    args: { itemId: string; reason: string },
  ): Promise<{ itemId: string }> {
    return this.tools.inbox.withdrawQuestion(ctx, args);
  }
  async setCurrentWork(ctx: ToolContext, args: WorkDoing): Promise<{ recorded: boolean }> {
    return this.tools.sessions.setCurrentWork(ctx, args);
  }

  async operate(ctx: ToolContext, args: Parameters<OperatorToolsHandler['operate']>[1]) {
    return this.tools.operator.operate(ctx, args);
  }

  async readProjectDoc(
    ctx: ToolContext,
    args: { doc: ProjectDoc; fromLine?: number; lineCount?: number },
  ): Promise<ProjectDocRead> {
    return this.tools.projectDocs.readProjectDoc(ctx, args);
  }

  async writeProjectDocs(
    ctx: ToolContext,
    args: {
      baseCommit: string;
      message: string;
      edits: { doc: ProjectDoc; old_text: string; new_text: string }[];
    },
  ): Promise<ProjectDocWrite> {
    return this.tools.projectDocs.writeProjectDocs(ctx, args);
  }

  async listDecisionCandidates(ctx: ToolContext, args: { limit?: number }) {
    return this.tools.projectDocs.listDecisionCandidates(ctx, args);
  }

  async markDecisionCandidates(
    ctx: ToolContext,
    args: { items: { item_id: string; verdict: 'recorded' | 'declined' | 'skipped'; decision?: string }[] },
  ) {
    return this.tools.projectDocs.markDecisionCandidates(ctx, args);
  }

  async startTask(
    ctx: ToolContext,
    args: { taskKey: string; assignee?: string; despitePrerequisites?: boolean; signalId?: string },
  ) {
    return this.tools.operator.startTask(ctx, args);
  }

  async startMember(
    ctx: ToolContext,
    args: { member: string; text: string; taskKey?: string; signalId?: string; despiteWorkers?: boolean },
  ): Promise<MemberStartResult> {
    return this.tools.operator.startMember(ctx, args);
  }
}
