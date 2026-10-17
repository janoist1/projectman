import type { AuthDomain } from '../auth';
import type { StructureService } from '../services/structure';
import type { RunnerModule } from '../contracts';
import type { ChangeJournal, TemplateRegistry } from '../core/base';
import type { AttachmentService, MessageAttachmentService } from '../core/attachments';
import type {
  BoardService,
  CardMeasure,
  InvolvementService,
  ProjectFocusService,
  TaskService,
  TaskWaits,
} from '../core/tasks';
import type { ProjectService, RoleService } from '../core/projects';
import type { InvitationService, MemberService, MemberProfiles, ProjectAccess } from '../core/members';
import type { MessageService, Messaging } from '../core/messages';
import type { InboxService } from '../core/inbox';
import type { SuperAuditService } from '../core/timeline';
import type { HandoffService, MessageStarts, TaskStarts } from '../runtime/admission';
import type { PauseService, SessionOrchestrator } from '../runtime/sessions';
import type { MachineMonitor, WorkOutages } from '../runtime/watchers';
import type { ProviderKeys } from '../runtime/usage';
import type { FeedbackService, FeedbackWidgetService } from '../services/feedback';
import type { BoundaryService } from '../services/boundary';
import type { Merges } from '../services/merges';
import type { ScheduleService } from '../services/schedules';
import type {
  OperatorKnowledge,
  OperatorPreferences,
  OperatorSignals,
  ProjectManagerChannels,
} from '../services/operator';

export interface ApiDomain extends AuthDomain {
  readonly structure: StructureService;
  readonly attachments: AttachmentService;
  readonly board: BoardService;
  readonly boundary: BoundaryService;
  readonly changes: ChangeJournal;
  readonly cardMeasure: CardMeasure;
  readonly feedback: FeedbackService;
  readonly feedbackWidget: FeedbackWidgetService;
  readonly handoffs: HandoffService;
  readonly inbox: InboxService;
  readonly invitations: InvitationService;
  readonly involvements: InvolvementService;
  readonly machine: MachineMonitor;
  readonly members: MemberService;
  readonly merges: Merges;
  readonly messageAttachments: MessageAttachmentService;
  readonly messageStarts: MessageStarts;
  readonly messages: MessageService;
  readonly messaging: Messaging;
  readonly operatorSignals: OperatorSignals;
  readonly operatorPreferences: OperatorPreferences;
  readonly sharedOperatorKnowledge: OperatorKnowledge;
  readonly outages: WorkOutages;
  readonly pauses: PauseService;
  readonly profiles: MemberProfiles;
  readonly projectFocus: ProjectFocusService;
  readonly projectManagerChannels: ProjectManagerChannels;
  readonly projects: ProjectService;
  readonly providerKeys: ProviderKeys | null;
  readonly roles: RoleService;
  readonly runnerModule: RunnerModule;
  readonly schedules: ScheduleService;
  readonly sessions: SessionOrchestrator;
  readonly superAudit: SuperAuditService;
  readonly taskStarts: TaskStarts;
  readonly taskWaits: TaskWaits;
  readonly tasks: TaskService;
  readonly templates: TemplateRegistry;
  accessFor(projectKey: string, email: string): Promise<ProjectAccess | null>;
}
