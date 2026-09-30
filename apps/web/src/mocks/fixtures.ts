import { getLocale, roleViews, standardLabel, standardLabelsFor } from '@projectman/templates';
import type {
  Actor,
  ChatItem,
  ConfigVersionEntry,
  InboxItem,
  InboxOption,
  MemberView,
  PlanUsage,
  ProjectConfig,
  ProjectSummary,
  RoleView,
  Session,
  Task,
  TeamMessage,
  TemplateSummary,
  TimelineEvent,
  TimelineEventType,
} from '@projectman/shared';
import { daysAgo, hoursFromNow, minutesAgo, mockUuid } from './time';

/**
 * A fictional project for the UI tests' MockBackend: "Acme webshop" with three humans (the owner, Kata the
 * client, Bence the tester) and seven AI members, tasks in every pipeline stage, open inbox
 * items, team messages and session chats. Titles and messages are data in the project's
 * language. Nothing here refers to a real client or person.
 */

export const PROJECT_KEY = 'AC';
export const OWNER = 'owner';

export const mockUser = {
  userId: 'usr_owner',
  name: 'Te',
  email: 'owner@acme.test',
};

/** Built-in option ids; like the server, the labels repeat the id and the UI translates them. */
const PERMISSION_OPTIONS: InboxOption[] = [
  { id: 'allow', label: 'allow', style: 'primary' },
  { id: 'allow_session', label: 'allow_session', style: 'secondary' },
  { id: 'deny', label: 'deny', style: 'danger' },
];
export const DECISION_OPTIONS: InboxOption[] = [
  { id: 'approve', label: 'approve', style: 'primary' },
  { id: 'reject', label: 'reject', style: 'danger' },
];
const ANSWER_OPTION: InboxOption = { id: 'answer', label: 'answer', style: 'secondary' };

export const templates: TemplateSummary[] = [
  {
    id: 'web-client-project',
    nameKey: 'templates.web-client-project.name',
    descriptionKey: 'templates.web-client-project.description',
    memberCount: { human: 1, ai: 7 },
    stageCount: 9,
  },
  {
    id: 'small-team',
    nameKey: 'templates.small-team.name',
    descriptionKey: 'templates.small-team.description',
    memberCount: { human: 1, ai: 2 },
    stageCount: 5,
  },
  {
    id: 'internal-tool',
    nameKey: 'templates.internal-tool.name',
    descriptionKey: 'templates.internal-tool.description',
    memberCount: { human: 1, ai: 4 },
    stageCount: 6,
  },
  {
    id: 'daily-routine',
    nameKey: 'templates.daily-routine.name',
    descriptionKey: 'templates.daily-routine.description',
    memberCount: { human: 1, ai: 1 },
    stageCount: 3,
  },
];

export function buildConfig(): ProjectConfig {
  return {
    schemaVersion: 1,
    project: {
      key: PROJECT_KEY,
      name: 'Acme webshop',
      workspacePath: '/Users/owner/Dev/acme-webshop',
      language: 'hu',
      timezone: 'Europe/Budapest',
      templateId: 'web-client-project',
      repos: [
        { name: 'webshop', path: 'webshop', github: 'acme/webshop', defaultBranch: 'main' },
        { name: 'admin', path: 'admin', github: 'acme/admin', defaultBranch: 'main' },
        { name: 'infra', path: 'infra', github: 'acme/infra', defaultBranch: 'main' },
      ],
    },
    team: {
      members: [
        {
          kind: 'human',
          handle: 'owner',
          displayName: 'Te',
          access: 'owner',
          roles: ['operator', 'product_owner'],
          email: 'owner@acme.test',
        },
        {
          kind: 'human',
          handle: 'kata',
          displayName: 'Kata',
          access: 'client',
          roles: [],
          email: 'kata@acme.test',
        },
        {
          kind: 'human',
          handle: 'bence',
          displayName: 'Bence',
          access: 'client',
          roles: [],
          email: 'bence@acme.test',
        },
        {
          kind: 'ai',
          handle: 'devops',
          displayName: 'Devops',
          role: 'devops',
          model: 'opus',
          permissionMode: 'default',
          capacity: 1,
          instructions:
            'You run the servers and deployments. Deploy to integration without asking; release to production only on an explicit request from the owner.',
          sponsor: 'owner',
          temp: false,
        },
        {
          kind: 'ai',
          handle: 'code-review',
          displayName: 'Code review',
          role: 'code_review',
          model: 'opus',
          permissionMode: 'plan',
          capacity: 1,
          instructions:
            'Review every pull request before integration: payments, orders, security. Never change code; report Blocking or Non-blocking with file:line.',
          sponsor: 'owner',
          temp: false,
        },
        {
          kind: 'ai',
          handle: 'qa',
          displayName: 'QA',
          role: 'qa',
          model: 'sonnet',
          permissionMode: 'default',
          capacity: 1,
          instructions:
            'Test on integration, in a real browser as well. Report bugs to the sender: what, where, how, with a screenshot.',
          sponsor: 'owner',
          temp: false,
        },
        {
          kind: 'ai',
          handle: 'communication',
          displayName: 'Kommunikáció',
          role: 'communication',
          model: 'opus',
          permissionMode: 'default',
          capacity: 1,
          instructions:
            'Write test requests and emails for the client. Money and ways of working go by email only; emails are drafts until a human approves them.',
          sponsor: 'owner',
          temp: false,
        },
        {
          kind: 'ai',
          handle: 'fe-1',
          displayName: 'Frontend fejlesztő',
          role: 'developer',
          specialty: 'frontend',
          model: 'opus',
          permissionMode: 'acceptEdits',
          capacity: 1,
          instructions: 'Frontend tasks in your own worktree. Attach screenshots to every pull request.',
          sponsor: 'owner',
          temp: false,
        },
        {
          kind: 'ai',
          handle: 'be-1',
          provider: 'codex',
          displayName: 'Backend fejlesztő',
          role: 'developer',
          specialty: 'backend',
          model: 'gpt-6.1-sol',
          permissionMode: 'acceptEdits',
          capacity: 1,
          instructions:
            'Backend tasks in your own worktree. Read-only access to databases; describe schema changes in the pull request.',
          sponsor: 'owner',
          temp: false,
        },
        {
          kind: 'ai',
          handle: 'dev-1',
          displayName: 'Általános fejlesztő',
          role: 'developer',
          model: 'sonnet',
          permissionMode: 'acceptEdits',
          capacity: 1,
          instructions:
            'Everything that does not fit elsewhere. Ask a human when the product decision is unclear.',
          sponsor: 'owner',
          temp: false,
        },
      ],
      roles: [],
      limits: {
        aiEnabled: true,
        maxConcurrentAi: 3,
        pauseAbovePlanUsagePercent: 80,
        tempWorkers: { enabled: false, max: 1, role: 'developer' },
      },
    },
    pipeline: {
      columns: [
        { id: 'ready', name: 'Indulhat', hint: 'Heti rangsorolás után' },
        { id: 'dev', name: 'Fejlesztés', hint: 'Saját session, saját worktree' },
        { id: 'review', name: 'Átnézés', hint: 'Code review → Integration → QA' },
        { id: 'client', name: 'Ügyfélteszt', hint: 'Kata vagy Bence próbálja ki' },
        { id: 'ship', name: 'Élesítésre vár', hint: 'Csak a te döntéseddel megy ki' },
        { id: 'done', name: 'Kész', hint: 'A héten élesbe ment' },
      ],
      stages: [
        { id: 'ready', name: 'Indulhat', kind: 'queue', owners: ['owner'], columnId: 'ready' },
        { id: 'dev', name: 'Fejlesztés', kind: 'work', owners: ['fe-1', 'be-1', 'dev-1'], columnId: 'dev' },
        {
          id: 'code_review',
          name: 'Code review',
          kind: 'step',
          owners: ['code-review'],
          columnId: 'review',
        },
        {
          id: 'integration',
          name: 'Integration',
          kind: 'step',
          owners: ['devops'],
          columnId: 'review',
          gate: { conditions: [{ type: 'has_label', label: 'code-review-ok' }] },
        },
        { id: 'qa', name: 'QA', kind: 'step', owners: ['qa'], columnId: 'review' },
        {
          id: 'client_test',
          name: 'Ügyfélteszt',
          kind: 'step',
          owners: ['communication', 'kata', 'bence'],
          columnId: 'client',
          gate: { conditions: [{ type: 'has_label', label: 'qa-ok' }] },
        },
        {
          id: 'merge',
          name: 'Merge',
          kind: 'step',
          owners: ['owner'],
          columnId: 'ship',
          gate: { conditions: [{ type: 'has_label', label: 'client-accepted' }] },
        },
        {
          id: 'release',
          name: 'Élesítés',
          kind: 'release',
          owners: ['owner', 'devops'],
          columnId: 'ship',
          gate: {
            conditions: [
              { type: 'has_label', label: 'pr-merged' },
              { type: 'has_label', label: 'release-approved' },
            ],
          },
        },
        { id: 'done', name: 'Kész', kind: 'done', owners: [], columnId: 'done' },
      ],
      labels: [
        ...standardLabelsFor(['code-review-ok', 'qa-ok', 'client-accepted', 'pr-merged'], getLocale('hu')),
        // The release approval duty's label; the owner holds the duty through the operator role.
        standardLabel('release-approved', getLocale('hu')),
      ],
    },
  };
}

export const configHistory: ConfigVersionEntry[] = [
  { version: 'c3f9a21', message: 'Új lépés: Élesítésre vár', author: 'Te', at: daysAgo(1, 18, 12) },
  {
    version: '8b12e07',
    message: 'QA és ügyfélteszt jelzés a kártyákon',
    author: 'Te',
    at: daysAgo(2, 10, 40),
  },
  { version: '51d0c4a', message: 'Kommunikáció: levél csak vázlatként', author: 'Te', at: daysAgo(3, 16, 5) },
  { version: 'a0e4471', message: 'Code review az integration elé', author: 'Te', at: daysAgo(4, 17, 41) },
  { version: '2f6d9b3', message: 'Projekt létrehozva sablonból', author: 'Te', at: daysAgo(7, 9, 30) },
];

export const projectSummary: ProjectSummary = {
  key: PROJECT_KEY,
  name: 'Acme webshop',
  templateId: 'web-client-project',
  configVersion: 'c3f9a21',
};

export const planUsage: PlanUsage = {
  fiveHourPercent: 38,
  weeklyPercent: 64,
  fiveHourResetsAt: hoursFromNow(2.4),
  weeklyResetsAt: hoursFromNow(70),
  fetchedAt: minutesAgo(2),
};

/* ---------- members (runtime view) ---------- */

export const members: MemberView[] = [
  {
    handle: 'owner',
    displayName: 'Te',
    kind: 'human',
    role: 'owner',
    roles: ['operator', 'product_owner'],
    specialty: null,
    status: 'online',
    activity: null,
    currentTaskKeys: [],
    sponsor: null,
    temp: false,
  },
  {
    handle: 'kata',
    displayName: 'Kata',
    kind: 'human',
    role: 'client',
    roles: [],
    specialty: null,
    status: 'offline',
    activity: 'Dönt a főoldali ajánlóról',
    currentTaskKeys: ['AC-18'],
    sponsor: null,
    temp: false,
  },
  {
    handle: 'bence',
    displayName: 'Bence',
    kind: 'human',
    role: 'client',
    roles: [],
    specialty: null,
    status: 'online',
    activity: 'Régi linkek tesztje',
    currentTaskKeys: ['AC-19'],
    sponsor: null,
    temp: false,
  },
  {
    handle: 'devops',
    displayName: 'Devops',
    kind: 'ai',
    role: 'devops',
    roles: ['devops'],
    specialty: null,
    status: 'waiting_for_human',
    activity: 'PR #11 élesítésére vár',
    currentTaskKeys: ['AC-17'],
    sponsor: 'owner',
    temp: false,
  },
  {
    handle: 'code-review',
    displayName: 'Code review',
    kind: 'ai',
    role: 'code_review',
    roles: ['code_review'],
    specialty: null,
    status: 'working',
    activity: 'PR #16 átnézése',
    currentTaskKeys: ['AC-25'],
    sponsor: 'owner',
    temp: false,
  },
  {
    handle: 'qa',
    displayName: 'QA',
    kind: 'ai',
    role: 'qa',
    roles: ['qa'],
    specialty: null,
    status: 'working',
    activity: 'Ajánló mobilon · 3/5',
    currentTaskKeys: ['AC-18'],
    sponsor: 'owner',
    temp: false,
  },
  {
    handle: 'communication',
    displayName: 'Kommunikáció',
    kind: 'ai',
    role: 'communication',
    roles: ['communication'],
    specialty: null,
    status: 'waiting_for_human',
    activity: 'Levélvázlat Katának',
    currentTaskKeys: [],
    sponsor: 'owner',
    temp: false,
  },
  {
    handle: 'fe-1',
    displayName: 'Frontend fejlesztő',
    kind: 'ai',
    role: 'developer',
    roles: ['developer'],
    specialty: 'frontend',
    status: 'waiting_for_human',
    activity: 'Engedélyre vár: git push',
    currentTaskKeys: ['AC-21'],
    sponsor: 'owner',
    temp: false,
  },
  {
    handle: 'be-1',
    displayName: 'Backend fejlesztő',
    kind: 'ai',
    role: 'developer',
    roles: ['developer'],
    specialty: 'backend',
    status: 'working',
    activity: 'Visszaállítási próba',
    currentTaskKeys: ['AC-20'],
    sponsor: 'owner',
    temp: false,
  },
  {
    handle: 'dev-1',
    displayName: 'Általános fejlesztő',
    kind: 'ai',
    role: 'developer',
    roles: ['developer'],
    specialty: null,
    status: 'waiting_for_human',
    activity: 'Kérdés: kell GA4?',
    currentTaskKeys: ['AC-22'],
    sponsor: 'owner',
    temp: false,
  },
];
for (const member of members) {
  const config = buildConfig().team.members.find((entry) => entry.handle === member.handle);
  if (config?.kind === 'ai')
    Object.assign(member, {
      provider: config.provider ?? 'claude',
      model: config.model,
      permissionMode: config.permissionMode,
    });
}

/* ---------- tasks ---------- */

function task(partial: Partial<Task> & Pick<Task, 'key' | 'title' | 'stageId' | 'status'>): Task {
  return {
    id: `tsk_${partial.key.toLowerCase().replace('-', '_')}`,
    projectKey: PROJECT_KEY,
    description: '',
    assignee: null,
    repo: null,
    priority: null,
    labels: [],
    links: [],
    visibility: 'internal',
    createdBy: OWNER,
    createdAt: daysAgo(6, 9, 30),
    updatedAt: daysAgo(1, 12, 0),
    closedAt: null,
    ...partial,
  };
}

export const tasks: Task[] = [
  task({
    key: 'AC-24',
    title: 'Hibariasztás a fizetési hibákra',
    description:
      'Jelezzen a rendszer, ha a fizetési vagy a rendelési kérések hibára futnak.\n\n- Riasztás a `/checkout` és a `/orders` hibáira\n- Napi összesítő a Kommunikációnak',
    stageId: 'ready',
    status: 'active',
    labels: ['Új'],
    repo: 'webshop',
    createdAt: minutesAgo(8 * 60 + 8),
    updatedAt: minutesAgo(8 * 60 + 8),
  }),
  task({
    key: 'AC-23',
    title: 'API-kulcsok cseréje',
    description:
      'A kulcscserék egy kártyán gyűlnek, és egy körben mennek, az új fizetési mód élesítése után.',
    stageId: 'ready',
    status: 'waiting',
    labels: ['Előfeltétel: új fizetési mód'],
    repo: 'infra',
    links: [{ kind: 'prerequisite', ref: 'AC-17', title: 'Kártyás fizetés átvételkor' }],
    createdAt: daysAgo(6, 11, 20),
    updatedAt: daysAgo(6, 11, 20),
  }),
  task({
    key: 'AC-20',
    title: 'Napi mentés és visszaállítási próba',
    description: 'Napi mentés az adatbázisról, heti visszaállítási próba, riasztás, ha a mentés elmarad.',
    stageId: 'dev',
    status: 'active',
    assignee: 'be-1',
    repo: 'infra',
    labels: ['Üzemeltetés'],
    createdAt: daysAgo(3, 10, 0),
    updatedAt: minutesAgo(22),
  }),
  task({
    key: 'AC-22',
    title: 'Látogatómérés a pénztár oldalon',
    description: 'Látogatómérés a vásárlási útvonalon. Kérdés: elég a süti nélküli, vagy kell GA4 is?',
    stageId: 'dev',
    status: 'active',
    assignee: 'dev-1',
    repo: 'webshop',
    createdAt: daysAgo(2, 13, 50),
    updatedAt: minutesAgo(60),
  }),
  task({
    key: 'AC-25',
    title: 'Számla PDF a rendelés-visszaigazolóhoz',
    description: 'A rendelés-visszaigazoló levél mellé PDF-számla a rendelés adataival.',
    stageId: 'code_review',
    status: 'active',
    assignee: 'be-1',
    repo: 'webshop',
    links: [
      {
        kind: 'pull_request',
        ref: '16',
        repo: 'acme/webshop',
        title: 'Invoice PDF for order confirmation',
        state: 'open',
      },
      { kind: 'branch', ref: '25-invoice-pdf', repo: 'acme/webshop' },
    ],
    createdAt: daysAgo(4, 9, 0),
    updatedAt: minutesAgo(12),
  }),
  task({
    key: 'AC-26',
    title: 'Kosár oldal gyorsítása',
    description: 'A kosár oldal fél másodperc alatt töltsön be, mobilon is.',
    stageId: 'integration',
    status: 'waiting',
    assignee: 'fe-1',
    repo: 'webshop',
    links: [
      { kind: 'pull_request', ref: '4', repo: 'acme/webshop', title: 'Faster cart page', state: 'open' },
    ],
    labels: ['code-review-ok'],
    createdAt: daysAgo(5, 14, 0),
    updatedAt: minutesAgo(95),
  }),
  task({
    key: 'AC-21',
    title: 'Rendelés-visszaigazoló e-mail',
    description:
      'Új visszaigazoló oldal a rendelés után, és hozzá illő e-mail sablon.\n\n1. Visszaigazoló oldal a rendelés összegzésével\n2. E-mail sablon ugyanazzal a tartalommal\n3. Mobilon is tördeljen',
    stageId: 'qa',
    status: 'active',
    assignee: 'fe-1',
    repo: 'webshop',
    labels: ['code-review-ok', 'qa-retest'],
    links: [
      {
        kind: 'pull_request',
        ref: '14',
        repo: 'acme/webshop',
        title: 'Order confirmation page and email',
        state: 'open',
      },
      { kind: 'branch', ref: '21-order-confirmation', repo: 'acme/webshop' },
    ],
    visibility: 'shared',
    createdAt: daysAgo(2, 9, 15),
    updatedAt: minutesAgo(99),
  }),
  task({
    key: 'AC-19',
    title: 'Régi termékoldal-linkek átirányítása',
    description:
      'A régi termékoldal-linkek a megfelelő új termékoldalra vigyenek, a megszűntek a kategóriára.',
    stageId: 'client_test',
    status: 'waiting',
    assignee: 'fe-1',
    repo: 'infra',
    labels: ['waiting-answer', 'code-review-ok', 'qa-ok'],
    links: [
      {
        kind: 'pull_request',
        ref: '3',
        repo: 'acme/infra',
        title: 'Redirect old product links',
        state: 'open',
      },
    ],
    visibility: 'shared',
    createdAt: daysAgo(3, 11, 0),
    updatedAt: daysAgo(1, 15, 52),
  }),
  task({
    key: 'AC-18',
    title: 'Főoldali ajánló: három változat',
    description: 'Három változat (A, B, C) a tesztszerveren. Kata választ, melyik menjen tovább.',
    stageId: 'client_test',
    status: 'waiting',
    assignee: 'dev-1',
    repo: 'webshop',
    labels: ['waiting-answer', 'code-review-ok', 'qa-ok'],
    links: [
      {
        kind: 'pull_request',
        ref: '1',
        repo: 'acme/webshop',
        title: 'Home page picks variants',
        state: 'open',
      },
    ],
    visibility: 'shared',
    createdAt: daysAgo(2, 10, 0),
    updatedAt: minutesAgo(250),
  }),
  task({
    key: 'AC-27',
    title: 'Hírlevél-feliratkozás a láblécben',
    description: 'Feliratkozó mező a láblécben, dupla megerősítéssel.',
    stageId: 'merge',
    status: 'waiting',
    assignee: 'fe-1',
    repo: 'webshop',
    labels: ['code-review-ok', 'qa-ok', 'client-accepted'],
    links: [
      { kind: 'pull_request', ref: '15', repo: 'acme/webshop', title: 'Newsletter signup', state: 'open' },
    ],
    visibility: 'shared',
    createdAt: daysAgo(5, 9, 0),
    updatedAt: minutesAgo(70),
  }),
  task({
    key: 'AC-17',
    title: 'Kártyás fizetés átvételkor',
    description:
      'Átvételkor kártyával is lehessen fizetni; a futár terminálja a rendeléshez kötött összeget kéri.',
    stageId: 'merge',
    status: 'waiting',
    assignee: 'be-1',
    repo: 'webshop',
    labels: ['code-review-ok', 'qa-ok', 'client-accepted'],
    links: [
      {
        kind: 'pull_request',
        ref: '11',
        repo: 'acme/webshop',
        title: 'Card payment on delivery',
        state: 'merged',
      },
    ],
    visibility: 'shared',
    createdAt: daysAgo(5, 9, 0),
    updatedAt: minutesAgo(32),
  }),
  task({
    key: 'AC-28',
    title: 'Szállítási díj kalkulátor a kosárban',
    description: 'A kosárban a szállítási díj az irányítószám alapján jelenjen meg, még a pénztár előtt.',
    stageId: 'release',
    status: 'active',
    assignee: 'fe-1',
    repo: 'webshop',
    labels: ['code-review-ok', 'qa-ok', 'client-accepted'],
    links: [
      {
        kind: 'pull_request',
        ref: '12',
        repo: 'acme/webshop',
        title: 'Shipping fee calculator',
        state: 'merged',
      },
    ],
    visibility: 'shared',
    createdAt: daysAgo(6, 9, 0),
    updatedAt: minutesAgo(15),
  }),
  task({
    key: 'AC-16',
    title: 'Admin naptár javítása',
    stageId: 'done',
    status: 'done',
    assignee: 'be-1',
    repo: 'admin',
    labels: ['code-review-ok', 'qa-ok'],
    links: [
      {
        kind: 'pull_request',
        ref: '18',
        repo: 'acme/admin',
        title: 'Fix the admin calendar',
        state: 'merged',
      },
    ],
    createdAt: minutesAgo(5 * 60),
    updatedAt: minutesAgo(125),
    closedAt: minutesAgo(125),
  }),
  task({
    key: 'AC-15',
    title: 'Függőségek frissítése',
    stageId: 'done',
    status: 'done',
    assignee: 'dev-1',
    repo: 'infra',
    links: [{ kind: 'pull_request', ref: '13', repo: 'acme/infra', state: 'merged' }],
    createdAt: daysAgo(3, 9, 0),
    updatedAt: minutesAgo(9 * 60),
    closedAt: minutesAgo(9 * 60),
  }),
  task({
    key: 'AC-14',
    title: 'Keresőoptimalizált termékoldalak',
    stageId: 'done',
    status: 'done',
    assignee: 'fe-1',
    repo: 'webshop',
    links: [{ kind: 'pull_request', ref: '10', repo: 'acme/webshop', state: 'merged' }],
    createdAt: daysAgo(4, 9, 0),
    updatedAt: daysAgo(1, 11, 30),
    closedAt: daysAgo(1, 11, 30),
  }),
  task({
    key: 'AC-13',
    title: 'Ékezetes nevek a számlán',
    stageId: 'done',
    status: 'done',
    assignee: 'be-1',
    repo: 'webshop',
    links: [{ kind: 'pull_request', ref: '9', repo: 'acme/webshop', state: 'merged' }],
    createdAt: daysAgo(5, 9, 0),
    updatedAt: daysAgo(2, 16, 10),
    closedAt: daysAgo(2, 16, 10),
  }),
];

/* ---------- timeline ---------- */

let eventSeq = 0;

function actor(handle: string | null): Actor {
  if (!handle) return { kind: 'system', handle: null };
  const member = members.find((m) => m.handle === handle);
  return { kind: member?.kind ?? 'system', handle };
}

function ev(
  taskKey: string,
  at: string,
  who: string | null,
  type: TimelineEventType,
  data: Record<string, unknown>,
  sessionId: string | null = null,
): TimelineEvent {
  eventSeq += 1;
  return {
    id: `evt_${eventSeq.toString().padStart(4, '0')}`,
    projectKey: PROJECT_KEY,
    taskKey,
    sessionId,
    actor: actor(who),
    type,
    data,
    createdAt: at,
  };
}

export const timeline: TimelineEvent[] = [
  ev('AC-24', minutesAgo(8 * 60 + 8), 'communication', 'task_created', {
    title: 'Hibariasztás a fizetési hibákra',
  }),
  ev('AC-24', minutesAgo(8 * 60 + 7), 'communication', 'task_note', {
    text: 'Kártya a retróból: jelezzen, ha a fizetési kérések hibára futnak',
  }),

  ev('AC-23', daysAgo(6, 11, 20), 'communication', 'task_created', { title: 'API-kulcsok cseréje' }),
  ev('AC-23', daysAgo(6, 11, 21), 'communication', 'task_link_added', { kind: 'prerequisite', ref: 'AC-17' }),
  ev('AC-23', daysAgo(6, 11, 22), 'communication', 'task_note', {
    text: 'A kulcscserék egy kártyán gyűlnek, és egy körben mennek',
  }),

  ev('AC-20', daysAgo(3, 10, 0), 'owner', 'task_created', { title: 'Napi mentés és visszaállítási próba' }),
  ev('AC-20', daysAgo(1, 15, 36), null, 'task_assigned', { assignee: 'be-1' }),
  ev('AC-20', daysAgo(1, 15, 36), null, 'task_stage_changed', { from: 'ready', to: 'dev' }),
  ev(
    'AC-20',
    daysAgo(1, 15, 36),
    'be-1',
    'session_started',
    { member: 'be-1', resumed: false },
    'ses_ac20_be1',
  ),
  ev('AC-20', minutesAgo(22), 'be-1', 'task_note', {
    text: 'A mentési szkript kész, a visszaállítás próbája fut',
  }),

  ev('AC-22', daysAgo(2, 13, 50), 'owner', 'task_created', { title: 'Látogatómérés a pénztár oldalon' }),
  ev('AC-22', daysAgo(2, 13, 52), null, 'task_assigned', { assignee: 'dev-1' }),
  ev('AC-22', daysAgo(2, 13, 52), null, 'task_stage_changed', { from: 'ready', to: 'dev' }),
  ev(
    'AC-22',
    daysAgo(2, 13, 52),
    'dev-1',
    'session_started',
    { member: 'dev-1', resumed: false },
    'ses_ac22_dev1',
  ),
  ev(
    'AC-22',
    minutesAgo(60),
    'dev-1',
    'question_asked',
    { inboxItemId: 'inb_q_ga4', question: 'Elég a süti nélküli mérés, vagy kell GA4 is?' },
    'ses_ac22_dev1',
  ),

  ev('AC-25', daysAgo(4, 9, 0), 'owner', 'task_created', { title: 'Számla PDF a rendelés-visszaigazolóhoz' }),
  ev('AC-25', daysAgo(1, 10, 2), 'be-1', 'task_link_added', {
    kind: 'pull_request',
    ref: '16',
    repo: 'acme/webshop',
  }),
  ev('AC-25', daysAgo(1, 10, 3), 'be-1', 'task_stage_changed', { from: 'dev', to: 'code_review' }),
  ev(
    'AC-25',
    minutesAgo(12),
    'code-review',
    'session_started',
    { member: 'code-review', resumed: false },
    'ses_ac25_cr',
  ),

  ev('AC-26', daysAgo(5, 14, 0), 'owner', 'task_created', { title: 'Kosár oldal gyorsítása' }),
  ev('AC-26', daysAgo(1, 9, 30), 'fe-1', 'task_link_added', {
    kind: 'pull_request',
    ref: '4',
    repo: 'acme/webshop',
  }),
  ev('AC-26', minutesAgo(120), 'code-review', 'task_labels_changed', {
    added: ['code-review-ok'],
    removed: [],
  }),
  ev('AC-26', minutesAgo(95), 'code-review', 'task_stage_changed', {
    from: 'code_review',
    to: 'integration',
  }),

  ev('AC-21', daysAgo(2, 9, 15), 'owner', 'task_created', { title: 'Rendelés-visszaigazoló e-mail' }),
  ev('AC-21', daysAgo(2, 9, 20), null, 'task_assigned', { assignee: 'fe-1' }),
  ev('AC-21', daysAgo(2, 9, 20), null, 'task_stage_changed', { from: 'ready', to: 'dev' }),
  ev(
    'AC-21',
    daysAgo(2, 9, 20),
    'fe-1',
    'session_started',
    { member: 'fe-1', resumed: false },
    'ses_ac21_fe1',
  ),
  ev(
    'AC-21',
    minutesAgo(198),
    'fe-1',
    'task_link_added',
    { kind: 'pull_request', ref: '14', repo: 'acme/webshop' },
    'ses_ac21_fe1',
  ),
  ev(
    'AC-21',
    minutesAgo(198),
    'fe-1',
    'task_stage_changed',
    { from: 'dev', to: 'code_review' },
    'ses_ac21_fe1',
  ),
  ev(
    'AC-21',
    minutesAgo(198),
    'fe-1',
    'team_message',
    { messageId: 'msg_07', from: 'fe-1', to: ['code-review'], excerpt: 'PR #14 nyitva, kérlek, nézd át.' },
    'ses_ac21_fe1',
  ),
  ev(
    'AC-21',
    minutesAgo(182),
    'code-review',
    'task_labels_changed',
    { added: ['code-review-ok'], removed: [] },
    'ses_ac21_cr',
  ),
  ev(
    'AC-21',
    minutesAgo(182),
    'code-review',
    'task_note',
    { text: 'Nem blokkol · 2 megjegyzés · mehet integrationre' },
    'ses_ac21_cr',
  ),
  ev(
    'AC-21',
    minutesAgo(181),
    'code-review',
    'task_stage_changed',
    { from: 'code_review', to: 'integration' },
    'ses_ac21_cr',
  ),
  ev('AC-21', minutesAgo(175), 'devops', 'task_note', { text: 'Kitelepítve az integrationre' }),
  ev('AC-21', minutesAgo(175), 'devops', 'task_stage_changed', { from: 'integration', to: 'qa' }),
  ev(
    'AC-21',
    minutesAgo(138),
    'qa',
    'task_labels_changed',
    { added: ['qa-retest'], removed: [] },
    'ses_ac21_qa',
  ),
  ev(
    'AC-21',
    minutesAgo(138),
    'qa',
    'task_note',
    { text: '5/6 forgatókönyv rendben · mobilon kilóg a gombsor' },
    'ses_ac21_qa',
  ),
  ev(
    'AC-21',
    minutesAgo(110),
    'fe-1',
    'task_note',
    { text: 'Javítva: a gombsor mobilon tördel (4e1c2a9)' },
    'ses_ac21_fe1',
  ),
  ev(
    'AC-21',
    minutesAgo(99),
    'fe-1',
    'permission_requested',
    { inboxItemId: 'inb_perm_push', toolName: 'Bash', summary: 'git push origin 21-order-confirmation' },
    'ses_ac21_fe1',
  ),

  ev('AC-19', daysAgo(3, 11, 0), 'owner', 'task_created', { title: 'Régi termékoldal-linkek átirányítása' }),
  ev('AC-19', daysAgo(1, 14, 36), 'fe-1', 'task_link_added', {
    kind: 'pull_request',
    ref: '3',
    repo: 'acme/infra',
  }),
  ev('AC-19', daysAgo(1, 14, 50), 'code-review', 'task_labels_changed', {
    added: ['code-review-ok'],
    removed: [],
  }),
  ev('AC-19', daysAgo(1, 15, 5), 'devops', 'task_note', { text: 'Kitelepítve az integrationre' }),
  ev('AC-19', daysAgo(1, 15, 40), 'qa', 'task_labels_changed', { added: ['qa-ok'], removed: [] }),
  ev('AC-19', daysAgo(1, 15, 41), 'qa', 'task_stage_changed', { from: 'qa', to: 'client_test' }),
  ev('AC-19', daysAgo(1, 15, 52), 'communication', 'team_message', {
    messageId: 'msg_08',
    from: 'communication',
    to: ['kata', 'bence'],
    excerpt: 'Tesztkérés: régi termékoldal-linkek',
  }),

  ev('AC-18', daysAgo(2, 10, 0), 'owner', 'task_created', { title: 'Főoldali ajánló: három változat' }),
  ev('AC-18', minutesAgo(310), 'dev-1', 'task_link_added', {
    kind: 'pull_request',
    ref: '1',
    repo: 'acme/webshop',
  }),
  ev('AC-18', minutesAgo(302), 'code-review', 'task_labels_changed', {
    added: ['code-review-ok'],
    removed: [],
  }),
  ev('AC-18', minutesAgo(295), 'devops', 'task_note', { text: 'Kint a tesztszerveren: /ajanlo' }),
  ev('AC-18', minutesAgo(280), 'qa', 'task_labels_changed', { added: ['qa-ok'], removed: [] }),
  ev('AC-18', minutesAgo(279), 'qa', 'task_stage_changed', { from: 'qa', to: 'client_test' }),
  ev('AC-18', minutesAgo(250), 'communication', 'question_asked', {
    inboxItemId: 'inb_q_variant',
    question: 'Melyik változat menjen tovább: A, B vagy C?',
  }),

  ev('AC-27', daysAgo(5, 9, 0), 'owner', 'task_created', { title: 'Hírlevél-feliratkozás a láblécben' }),
  ev('AC-27', daysAgo(1, 16, 0), 'bence', 'task_labels_changed', { added: ['client-accepted'], removed: [] }),
  ev('AC-27', minutesAgo(70), 'bence', 'task_stage_changed', { from: 'client_test', to: 'merge' }),

  ev('AC-17', daysAgo(5, 9, 0), 'owner', 'task_created', { title: 'Kártyás fizetés átvételkor' }),
  ev('AC-17', daysAgo(2, 11, 0), 'be-1', 'task_link_added', {
    kind: 'pull_request',
    ref: '11',
    repo: 'acme/webshop',
  }),
  ev('AC-17', daysAgo(2, 12, 0), 'code-review', 'task_note', {
    text: 'Lelet: sikertelen kártyás fizetés után megszűnt a rendelés. Javítva ebben a PR-ban',
  }),
  ev('AC-17', daysAgo(1, 10, 0), 'qa', 'task_labels_changed', { added: ['qa-ok'], removed: [] }),
  ev('AC-17', daysAgo(1, 16, 30), 'kata', 'task_labels_changed', { added: ['client-accepted'], removed: [] }),
  ev('AC-17', minutesAgo(160), 'owner', 'task_stage_changed', { from: 'client_test', to: 'merge' }),
  ev('AC-17', minutesAgo(40), 'owner', 'task_note', { text: 'Merge megvolt' }),
  ev('AC-17', minutesAgo(32), 'devops', 'task_updated', {
    fields: ['status'],
    gateRequest: { requestId: 'gr_01', from: 'merge', to: 'release', inboxItemIds: ['inb_dec_release'] },
  }),

  ev('AC-28', daysAgo(6, 9, 0), 'owner', 'task_created', { title: 'Szállítási díj kalkulátor a kosárban' }),
  ev('AC-28', daysAgo(1, 13, 0), 'owner', 'task_stage_changed', { from: 'client_test', to: 'merge' }),
  ev('AC-28', minutesAgo(15), 'owner', 'task_stage_changed', {
    from: 'merge',
    to: 'release',
    approvedBy: ['owner'],
  }),
  ev('AC-16', minutesAgo(5 * 60), 'be-1', 'task_link_added', {
    kind: 'pull_request',
    ref: '18',
    repo: 'acme/admin',
  }),
  ev('AC-16', minutesAgo(135), 'owner', 'task_stage_changed', { from: 'merge', to: 'release' }),
  ev('AC-16', minutesAgo(125), 'devops', 'task_note', { text: 'Élesen: release-2026-09-29.2' }),
  ev('AC-16', minutesAgo(125), 'devops', 'task_stage_changed', { from: 'release', to: 'done' }),

  ev('AC-15', minutesAgo(9 * 60), 'devops', 'task_stage_changed', { from: 'release', to: 'done' }),
  ev('AC-14', daysAgo(1, 11, 30), 'devops', 'task_stage_changed', { from: 'release', to: 'done' }),
  ev('AC-13', daysAgo(2, 16, 10), 'devops', 'task_stage_changed', { from: 'release', to: 'done' }),
];

/* ---------- sessions ---------- */

function session(
  partial: Partial<Session> & Pick<Session, 'id' | 'member' | 'workItem' | 'state'>,
  seed: number,
): Session {
  return {
    projectKey: PROJECT_KEY,
    claudeSessionId: mockUuid(seed),
    cwd: '/Users/owner/Dev/acme-webshop',
    branch: null,
    transcriptPath: null,
    activity: null,
    startedAt: daysAgo(1, 9, 0),
    lastActivityAt: minutesAgo(30),
    endedAt: null,
    ...partial,
  };
}

export const sessions: Session[] = [
  session(
    {
      id: 'ses_ac21_fe1',
      member: 'fe-1',
      workItem: { type: 'task', taskKey: 'AC-21' },
      state: 'waiting_permission',
      cwd: '/Users/owner/.projectman/worktrees/AC/AC-21-order-confirmation',
      branch: '21-order-confirmation',
      activity: 'Bash: git push origin 21-order-confirmation',
      startedAt: daysAgo(2, 9, 20),
      lastActivityAt: minutesAgo(99),
    },
    21,
  ),
  session(
    {
      id: 'ses_ac21_cr',
      member: 'code-review',
      workItem: { type: 'task', taskKey: 'AC-21' },
      state: 'exited',
      branch: '21-order-confirmation',
      startedAt: minutesAgo(197),
      lastActivityAt: minutesAgo(181),
      endedAt: minutesAgo(180),
    },
    211,
  ),
  session(
    {
      id: 'ses_ac21_qa',
      member: 'qa',
      workItem: { type: 'task', taskKey: 'AC-21' },
      state: 'exited',
      startedAt: minutesAgo(170),
      lastActivityAt: minutesAgo(138),
      endedAt: minutesAgo(136),
    },
    212,
  ),
  session(
    {
      id: 'ses_ac20_be1',
      member: 'be-1',
      workItem: { type: 'task', taskKey: 'AC-20' },
      state: 'working',
      cwd: '/Users/owner/.projectman/worktrees/AC/AC-20-backups',
      branch: '20-backups',
      activity: 'Bash: ./scripts/restore-drill.sh',
      startedAt: daysAgo(1, 15, 36),
      lastActivityAt: minutesAgo(1),
    },
    20,
  ),
  session(
    {
      id: 'ses_ac22_dev1',
      member: 'dev-1',
      workItem: { type: 'task', taskKey: 'AC-22' },
      state: 'idle',
      cwd: '/Users/owner/.projectman/worktrees/AC/AC-22-analytics',
      branch: '22-analytics',
      activity: 'Kérdés a tulajdonosnak',
      startedAt: daysAgo(2, 13, 52),
      lastActivityAt: minutesAgo(60),
    },
    22,
  ),
  session(
    {
      id: 'ses_ac25_cr',
      member: 'code-review',
      workItem: { type: 'task', taskKey: 'AC-25' },
      state: 'working',
      branch: '25-invoice-pdf',
      activity: 'Read: src/Invoice/InvoicePdf.php',
      startedAt: minutesAgo(12),
      lastActivityAt: minutesAgo(1),
    },
    25,
  ),
  session(
    {
      id: 'ses_ac18_qa',
      member: 'qa',
      workItem: { type: 'task', taskKey: 'AC-18' },
      state: 'working',
      activity: 'Playwright: ajánló mobilon 3/5',
      startedAt: minutesAgo(40),
      lastActivityAt: minutesAgo(2),
    },
    18,
  ),
  session(
    {
      id: 'ses_ac17_devops',
      member: 'devops',
      workItem: { type: 'task', taskKey: 'AC-17' },
      state: 'idle',
      activity: 'Kiadási terv kész',
      startedAt: minutesAgo(50),
      lastActivityAt: minutesAgo(32),
    },
    17,
  ),
  session(
    {
      id: 'ses_ac16_be1',
      member: 'be-1',
      workItem: { type: 'task', taskKey: 'AC-16' },
      state: 'exited',
      branch: '16-admin-calendar',
      startedAt: minutesAgo(5 * 60),
      lastActivityAt: minutesAgo(140),
      endedAt: minutesAgo(125),
    },
    16,
  ),
  session(
    {
      id: 'ses_gen_comm',
      member: 'communication',
      workItem: { type: 'general' },
      state: 'idle',
      activity: 'Levélvázlat Katának',
      startedAt: minutesAgo(90),
      lastActivityAt: minutesAgo(70),
    },
    99,
  ),
];

/* ---------- chat ---------- */

let chatSeq = 0;

function chatId(): string {
  chatSeq += 1;
  return `chat_${chatSeq.toString().padStart(4, '0')}`;
}

function user(at: string, text: string): ChatItem {
  return { id: chatId(), ts: at, kind: 'user_text', text, origin: 'human' };
}

function assistant(at: string, text: string): ChatItem {
  return { id: chatId(), ts: at, kind: 'assistant_text', text };
}

function tool(
  at: string,
  name: string,
  summary: string,
  input: unknown,
  result?: { ok: boolean; summary: string },
): ChatItem[] {
  const toolUseId = `toolu_${chatSeq + 1}`;
  const call: ChatItem = { id: chatId(), ts: at, kind: 'tool_call', toolUseId, name, summary, input };
  if (!result) return [call];
  return [
    call,
    { id: chatId(), ts: at, kind: 'tool_result', toolUseId, ok: result.ok, summary: result.summary },
  ];
}

function teamIn(at: string, from: string, to: string[], text: string): ChatItem {
  return { id: chatId(), ts: at, kind: 'team_message', direction: 'in', from, to, text };
}

function teamOut(at: string, from: string, to: string[], text: string): ChatItem {
  return { id: chatId(), ts: at, kind: 'team_message', direction: 'out', from, to, text };
}

function note(at: string, text: string): ChatItem {
  return { id: chatId(), ts: at, kind: 'system_note', text };
}

export const chats: Record<string, ChatItem[]> = {
  ses_ac21_fe1: [
    user(
      daysAgo(2, 9, 20),
      'Task AC-21: Rendelés-visszaigazoló e-mail\n\nÚj visszaigazoló oldal a rendelés után, és hozzá illő e-mail sablon. Repo: webshop, branch 21-order-confirmation.',
    ),
    assistant(
      daysAgo(2, 9, 21),
      'Megnézem a meglévő visszaigazoló oldalt és a levélsablonokat, aztán az újat a meglévő `_summary` részletre építem.',
    ),
    ...tool(
      daysAgo(2, 9, 22),
      'Read',
      'templates/order/confirmation.html.twig',
      { file_path: 'templates/order/confirmation.html.twig' },
      { ok: true, summary: '142 sor' },
    ),
    ...tool(
      daysAgo(2, 9, 25),
      'Grep',
      'order_confirmation_email',
      { pattern: 'order_confirmation_email' },
      { ok: true, summary: '6 találat' },
    ),
    ...tool(
      daysAgo(2, 10, 5),
      'Edit',
      'templates/emails/order_confirmation.html.twig',
      { file_path: 'templates/emails/order_confirmation.html.twig' },
      { ok: true, summary: '+96 −12' },
    ),
    ...tool(
      minutesAgo(200),
      'Bash',
      'npm run build',
      { command: 'npm run build' },
      { ok: true, summary: 'rendben · 14 mp' },
    ),
    ...tool(
      minutesAgo(199),
      'Bash',
      'gh pr create --title "Order confirmation page and email"',
      { command: 'gh pr create' },
      { ok: true, summary: 'PR #14' },
    ),
    ...tool(
      minutesAgo(198),
      'mcp__team__send_message',
      'code-review: PR #14 nyitva',
      { to: ['code-review'] },
      { ok: true, summary: 'kézbesítve' },
    ),
    teamOut(
      minutesAgo(198),
      'fe-1',
      ['code-review'],
      'PR #14 nyitva: rendelés-visszaigazoló oldal és e-mail sablon. Kérlek, nézd át.',
    ),
    assistant(minutesAgo(197), 'A PR #14 megnyitva, szóltam a Code review-nak.'),
    note(minutesAgo(183), 'A session pihen, amíg a Code review dolgozik.'),
    teamIn(
      minutesAgo(182),
      'code-review',
      ['fe-1', 'devops'],
      'Nem blokkol, mehet integrationre. 2 megjegyzés: OrderController.php:88, confirmation.html.twig:41.',
    ),
    teamIn(
      minutesAgo(138),
      'qa',
      ['fe-1'],
      '5/6 forgatókönyv rendben. Hiba: 390 px szélességen a visszaigazoló oldal gombsora kilóg a képernyőből. Képernyőkép csatolva.',
    ),
    assistant(
      minutesAgo(137),
      'Megnézem. A gombsor fix szélességű, és mobilon nincs töréspontja. Rugalmasra írom, aztán újratesztet kérek a QA-tól.',
    ),
    ...tool(
      minutesAgo(136),
      'Read',
      'templates/order/confirmation.html.twig',
      { file_path: 'templates/order/confirmation.html.twig' },
      { ok: true, summary: '142 sor' },
    ),
    ...tool(
      minutesAgo(125),
      'Edit',
      'assets/css/confirmation.css',
      { file_path: 'assets/css/confirmation.css' },
      { ok: true, summary: '+9 −3' },
    ),
    ...tool(
      minutesAgo(112),
      'Bash',
      'npm run build',
      { command: 'npm run build' },
      { ok: true, summary: 'rendben · 14 mp' },
    ),
    ...tool(
      minutesAgo(110),
      'Bash',
      'git commit -m "Make confirmation actions wrap on mobile"',
      { command: 'git commit -m "Make confirmation actions wrap on mobile"' },
      { ok: true, summary: '4e1c2a9' },
    ),
    ...tool(minutesAgo(99), 'Bash', 'git push origin 21-order-confirmation', {
      command: 'git push origin 21-order-confirmation',
    }),
  ],
  ses_ac20_be1: [
    user(
      daysAgo(1, 15, 36),
      'Task AC-20: Napi mentés és visszaállítási próba\n\nNapi mentés, heti visszaállítási próba, riasztás.',
    ),
    assistant(daysAgo(1, 15, 38), 'Először a meglévő mentési szkripteket nézem át az infra repóban.'),
    ...tool(
      daysAgo(1, 15, 39),
      'Glob',
      'scripts/**/*.sh',
      { pattern: 'scripts/**/*.sh' },
      { ok: true, summary: '7 fájl' },
    ),
    ...tool(
      daysAgo(1, 15, 45),
      'Write',
      'scripts/backup.sh',
      { file_path: 'scripts/backup.sh' },
      { ok: true, summary: '+64' },
    ),
    ...tool(
      minutesAgo(40),
      'Write',
      'scripts/restore-drill.sh',
      { file_path: 'scripts/restore-drill.sh' },
      { ok: true, summary: '+88' },
    ),
    assistant(
      minutesAgo(23),
      'A mentési szkript kész. Most a visszaállítás próbáját futtatom egy eldobható adatbázison.',
    ),
    ...tool(
      minutesAgo(22),
      'Bash',
      './scripts/restore-drill.sh --dry-run',
      { command: './scripts/restore-drill.sh --dry-run' },
      { ok: true, summary: 'rendben · 41 mp' },
    ),
    ...tool(minutesAgo(1), 'Bash', './scripts/restore-drill.sh', { command: './scripts/restore-drill.sh' }),
  ],
  ses_ac22_dev1: [
    user(daysAgo(2, 13, 52), 'Task AC-22: Látogatómérés a pénztár oldalon'),
    assistant(
      daysAgo(2, 13, 55),
      'Két út van: süti nélküli mérés (banner nélkül), vagy GA4 (hozzájárulás kell). Ezt nem nekem kell eldöntenem.',
    ),
    ...tool(
      minutesAgo(60),
      'mcp__team__ask_human',
      'Elég a süti nélküli mérés, vagy kell GA4 is?',
      { question: 'GA4?' },
      { ok: true, summary: 'kérdés a Rád vár listában' },
    ),
    assistant(
      minutesAgo(59),
      'Feltettem a kérdést. Amíg nem jön válasz, a süti nélküli változatot készítem elő, mert az mindkét esetben kell.',
    ),
  ],
  ses_ac25_cr: [
    user(
      minutesAgo(12),
      '[team message from be-1 about AC-25]\nPR #16 nyitva: PDF-számla a rendelés-visszaigazolóhoz. Kérlek, nézd át.',
    ),
    ...tool(
      minutesAgo(11),
      'Bash',
      'gh pr diff 16',
      { command: 'gh pr diff 16' },
      { ok: true, summary: '9 fájl · +312 −40' },
    ),
    ...tool(minutesAgo(1), 'Read', 'src/Invoice/InvoicePdf.php', { file_path: 'src/Invoice/InvoicePdf.php' }),
  ],
  ses_ac18_qa: [
    user(
      minutesAgo(40),
      '[team message from communication about AC-18]\nKérlek, nézd meg a változatokat mobilon is, mielőtt Kata dönt.',
    ),
    ...tool(
      minutesAgo(35),
      'mcp__playwright__browser_navigate',
      'https://test.acme.test/ajanlo/a',
      {},
      { ok: true, summary: 'betöltve' },
    ),
    ...tool(
      minutesAgo(20),
      'mcp__playwright__browser_take_screenshot',
      'A · 390×844',
      {},
      { ok: true, summary: 'kép mentve' },
    ),
    ...tool(minutesAgo(2), 'mcp__playwright__browser_take_screenshot', 'C · 390×844', {}),
  ],
  ses_ac17_devops: [
    user(
      minutesAgo(50),
      '[team message from owner about AC-17]\nKészítsd elő a kiadást, de csak a jóváhagyásom után menjen ki.',
    ),
    ...tool(
      minutesAgo(45),
      'Bash',
      'git log --oneline main -5',
      { command: 'git log --oneline main -5' },
      { ok: true, summary: '5 commit' },
    ),
    assistant(
      minutesAgo(32),
      'Kiadási terv kész: release-2026-09-30.1, benne a PR #11. Élesbe csak a jóváhagyásod után megy.',
    ),
  ],
  ses_gen_comm: [
    user(minutesAgo(90), 'Írj egy rövid levelet Katának a tesztszerver havi költségéről.'),
    assistant(
      minutesAgo(80),
      'Vázlatot írtam, és jóváhagyásra a Rád vár listába tettem. Pénzről szól, ezért e-mailben megy, nem a feladatok közé.',
    ),
  ],
};

for (const [sessionId, items] of Object.entries(chats)) {
  if (sessions.find((session) => session.id === sessionId)?.workItem.type !== 'task') continue;
  const first = items.find((item) => item.kind === 'user_text');
  if (first?.kind === 'user_text') first.origin = 'brief';
}

/* ---------- inbox ---------- */

export const inbox: InboxItem[] = [
  {
    id: 'inb_perm_push',
    projectKey: PROJECT_KEY,
    kind: 'permission',
    assignees: ['owner'],
    source: 'fe-1',
    sessionId: 'ses_ac21_fe1',
    taskKey: 'AC-21',
    title: 'Bash: git push origin 21-order-confirmation',
    body: null,
    payload: {
      toolName: 'Bash',
      toolInput: {
        command: 'git push origin 21-order-confirmation',
        description: 'Push the fix to the PR branch',
      },
      summary: 'git push origin 21-order-confirmation',
    },
    options: PERMISSION_OPTIONS,
    state: 'open',
    resolution: null,
    createdAt: minutesAgo(99),
  },
  {
    id: 'inb_dec_release',
    projectKey: PROJECT_KEY,
    kind: 'decision',
    assignees: ['owner'],
    source: 'devops',
    sessionId: null,
    taskKey: 'AC-17',
    title: 'Kártyás fizetés átvételkor',
    body: null,
    payload: {
      gate: {
        requestId: 'gr_01',
        taskKey: 'AC-17',
        fromStageId: 'merge',
        toStageId: 'release',
        stageId: 'release',
        conditionIndex: 1,
        requestedBy: { kind: 'ai', handle: 'devops' },
      },
    },
    options: DECISION_OPTIONS,
    state: 'open',
    resolution: null,
    createdAt: minutesAgo(32),
  },
  {
    id: 'inb_dec_comment',
    projectKey: PROJECT_KEY,
    kind: 'decision',
    assignees: ['owner'],
    source: 'code-review',
    sessionId: null,
    taskKey: null,
    title: 'Külső hozzájáruló PR-ja: 1 blokkoló lelet. Kimehet a komment?',
    body: 'A hozzáférés-szabály végéről hiányzik a $, így az /api/calendar is bejelentkezés mögé kerülne.',
    payload: { code: 'config/security.yml:42   ^/api/calendar' },
    options: DECISION_OPTIONS,
    state: 'open',
    resolution: null,
    createdAt: minutesAgo(18),
  },
  {
    id: 'inb_appr_email',
    projectKey: PROJECT_KEY,
    kind: 'approval',
    assignees: ['owner'],
    source: 'communication',
    sessionId: 'ses_gen_comm',
    taskKey: null,
    title: 'Levél Katának: a tesztszerver havi költsége',
    body: 'Kata, a tesztszerver havi költségéről még vár a döntés. Rendben van így, vagy beszéljük át a pénteki körön?',
    payload: { channel: 'email', to: 'kata@acme.test' },
    options: DECISION_OPTIONS,
    state: 'open',
    resolution: null,
    createdAt: minutesAgo(70),
  },
  {
    id: 'inb_q_ga4',
    projectKey: PROJECT_KEY,
    kind: 'question',
    assignees: ['owner'],
    source: 'dev-1',
    sessionId: 'ses_ac22_dev1',
    taskKey: 'AC-22',
    title: 'Elég a süti nélküli látogatómérés, vagy kell GA4 is?',
    body: 'A süti nélküli mérés banner nélkül működik, a GA4-hez hozzájárulás kell.',
    payload: {
      question: 'Elég a süti nélküli látogatómérés, vagy kell GA4 is?',
      options: ['Elég a süti nélküli', 'Kell GA4 is'],
    },
    options: [
      { id: 'option_1', label: 'Elég a süti nélküli', style: 'primary' },
      { id: 'option_2', label: 'Kell GA4 is', style: 'secondary' },
      ANSWER_OPTION,
    ],
    state: 'open',
    resolution: null,
    createdAt: minutesAgo(60),
  },
  {
    id: 'inb_q_variant',
    projectKey: PROJECT_KEY,
    kind: 'question',
    assignees: ['kata'],
    source: 'communication',
    sessionId: null,
    taskKey: 'AC-18',
    title: 'Melyik változat menjen tovább?',
    body: 'Mindhárom kint van a tesztszerveren: /ajanlo. Mobilon is betöltenek.',
    payload: { question: 'Melyik változat menjen tovább?', options: ['A', 'B', 'C'] },
    options: [
      { id: 'option_1', label: 'A', style: 'secondary' },
      { id: 'option_2', label: 'B', style: 'secondary' },
      { id: 'option_3', label: 'C', style: 'secondary' },
      ANSWER_OPTION,
    ],
    state: 'open',
    resolution: null,
    createdAt: minutesAgo(250),
  },
  {
    id: 'inb_old_release',
    projectKey: PROJECT_KEY,
    kind: 'decision',
    assignees: ['owner'],
    source: 'devops',
    sessionId: null,
    taskKey: 'AC-16',
    title: 'Admin naptár javítása',
    body: null,
    payload: {
      gate: {
        requestId: 'gr_00',
        taskKey: 'AC-16',
        fromStageId: 'merge',
        toStageId: 'release',
        stageId: 'release',
        conditionIndex: 1,
        requestedBy: { kind: 'ai', handle: 'devops' },
      },
    },
    options: DECISION_OPTIONS,
    state: 'resolved',
    resolution: { optionId: 'approve', by: 'owner', at: minutesAgo(135), note: null },
    createdAt: minutesAgo(140),
  },
  {
    id: 'inb_old_tofu',
    projectKey: PROJECT_KEY,
    kind: 'permission',
    assignees: ['owner'],
    source: 'devops',
    sessionId: null,
    taskKey: null,
    title: 'Bash: tofu plan',
    body: null,
    payload: { toolName: 'Bash', toolInput: { command: 'tofu plan' }, summary: 'tofu plan' },
    options: PERMISSION_OPTIONS,
    state: 'resolved',
    resolution: { optionId: 'allow', by: 'owner', at: minutesAgo(160), note: null },
    createdAt: minutesAgo(161),
  },
];

/**
 * An open question as an AI member writes it with the plain-language fields: one plain sentence,
 * each option described by what happens if it is picked, a recommendation with its reason and
 * folded technical details. Not part of the default inbox (the other questions stay old-style);
 * tests put it into `MockBackend.inbox`.
 */
export function plainLanguageQuestion(overrides: Partial<InboxItem> = {}): InboxItem {
  const question = 'A hibás e-mail cím hibaüzenete az űrlap alatt jelenjen meg, vagy felugró ablakban?';
  return {
    id: 'inb_q_error_message',
    projectKey: PROJECT_KEY,
    kind: 'question',
    assignees: ['owner'],
    source: 'dev-1',
    sessionId: 'ses_ac22_dev1',
    taskKey: 'AC-22',
    title: question,
    body: null,
    payload: {
      question,
      options: ['Az űrlap alatt', 'Felugró ablakban'],
      recommended: 'option_1',
      recommendationReason: 'Telefonon is jól olvasható, és nem tűnik el magától.',
      details:
        'Az `EmailField` már most kiírja a hibát `aria-live` sávban.\n\n' +
        'Felugró ablakhoz új `ToastProvider` kellene a `CheckoutPage` köré.',
    },
    options: [
      {
        id: 'option_1',
        label: 'Az űrlap alatt',
        style: 'primary',
        consequence: 'A hibaüzenet addig látszik, amíg ki nem javítod a címet.',
      },
      {
        id: 'option_2',
        label: 'Felugró ablakban',
        style: 'secondary',
        consequence: 'Pár másodperc múlva eltűnik, ezért könnyű lemaradni róla.',
      },
      ANSWER_OPTION,
    ],
    state: 'open',
    resolution: null,
    createdAt: minutesAgo(5),
    ...overrides,
  };
}

/* ---------- team messages ---------- */

function msg(
  id: string,
  at: string,
  from: string,
  to: string[],
  taskKey: string | null,
  body: string,
): TeamMessage {
  return { id, projectKey: PROJECT_KEY, from, to, taskKey, body, createdAt: at, deliveredAt: at };
}

export const teamMessages: TeamMessage[] = [
  msg(
    'msg_09',
    minutesAgo(250),
    'communication',
    ['kata'],
    'AC-18',
    'Kérdés: melyik változat menjen tovább, az A, a B vagy a C? Mindhárom kint van a tesztszerveren: /ajanlo.',
  ),
  msg(
    'msg_08',
    daysAgo(1, 15, 52),
    'communication',
    ['kata', 'bence'],
    'AC-19',
    'Tesztkérés: nyissatok meg egy régi termékoldal-linket. Az átirányításnak a megfelelő új termékoldalra kell vinnie.',
  ),
  msg(
    'msg_07',
    minutesAgo(198),
    'fe-1',
    ['code-review'],
    'AC-21',
    'PR #14 nyitva: rendelés-visszaigazoló oldal és e-mail sablon. Kérlek, nézd át.',
  ),
  msg(
    'msg_06',
    minutesAgo(182),
    'code-review',
    ['fe-1', 'devops'],
    'AC-21',
    'Nem blokkol, mehet integrationre. 2 megjegyzés: OrderController.php:88, confirmation.html.twig:41.',
  ),
  msg(
    'msg_05',
    minutesAgo(175),
    'devops',
    ['qa'],
    'AC-21',
    'A PR #14 kint van az integrationön, mehet a teszt.',
  ),
  msg(
    'msg_04',
    minutesAgo(138),
    'qa',
    ['fe-1'],
    'AC-21',
    '5/6 rendben. Hiba: 390 px-en kilóg a gombsor. Képernyőkép csatolva.',
  ),
  msg(
    'msg_03',
    minutesAgo(137),
    'fe-1',
    ['qa'],
    'AC-21',
    'Megvan, javítom. A javítást előbb a Code review nézi át, utána jöhet az újrateszt.',
  ),
  msg(
    'msg_02',
    minutesAgo(32),
    'devops',
    ['owner'],
    'AC-17',
    'Kiadási terv kész: release-2026-09-30.1, benne a PR #11. Kiadhatom?',
  ),
  msg(
    'msg_01',
    minutesAgo(18),
    'code-review',
    ['owner'],
    null,
    'Egy külső hozzájáruló PR-jában 1 blokkoló lelet van a hozzáférés-szabályokban. A PR-komment a döntésedre vár.',
  ),
];

/** The built-in part of the server's role catalogue for this project. */
export const builtInRoles: RoleView[] = roleViews(buildConfig()).filter((role) => role.builtIn);
