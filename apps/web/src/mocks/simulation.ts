import type { ChatItem, InboxItem } from '@projectman/shared';
import type { MockBackend } from './backend';
import { PROJECT_KEY } from './fixtures';
import { mockId, nowIso } from './time';

const BE_SESSION = 'ses_ac20_be1';
const QA_SESSION = 'ses_ac18_qa';
const CR_SESSION = 'ses_ac25_cr';

const backendSteps: Array<{ name: string; summary: string; result: string; activity: string }> = [
  {
    name: 'Bash',
    summary: './scripts/restore-drill.sh',
    result: 'rendben · 2 p 12 mp',
    activity: 'Visszaállítási próba',
  },
  { name: 'Read', summary: 'monitoring/alerts.yml', result: '54 sor', activity: 'Riasztások átnézése' },
  {
    name: 'Edit',
    summary: 'monitoring/alerts.yml',
    result: '+18 −2',
    activity: 'Riasztás a kimaradt mentésre',
  },
  { name: 'Bash', summary: 'make lint', result: 'rendben · 6 mp', activity: 'Ellenőrzés' },
];

function pendingToolCall(chat: ChatItem[]): Extract<ChatItem, { kind: 'tool_call' }> | undefined {
  const answered = new Set(chat.flatMap((item) => (item.kind === 'tool_result' ? [item.toolUseId] : [])));
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const item = chat[i];
    if (item?.kind === 'tool_call' && !answered.has(item.toolUseId)) return item;
  }
  return undefined;
}

/**
 * A few scripted live events so the demo moves on its own: the backend developer keeps
 * working, QA finishes a check, code review approves a PR, and a new permission request
 * arrives.
 */
export function startSimulation(backend: MockBackend): void {
  let tick = 0;
  let beStep = 0;

  const advanceBackend = () => {
    const session = backend.findSession(BE_SESSION);
    if (!session || session.state !== 'working') return;
    const chat = backend.chats[BE_SESSION] ?? [];
    const pending = pendingToolCall(chat);
    const current = backendSteps[beStep % backendSteps.length]!;
    if (pending) {
      backend.appendChat(BE_SESSION, [
        backend.chatItem('tool_result', { toolUseId: pending.toolUseId, ok: true, summary: current.result }),
      ]);
    }
    beStep += 1;
    const next = backendSteps[beStep % backendSteps.length]!;
    backend.appendChat(BE_SESSION, [
      backend.chatItem('tool_call', {
        toolUseId: mockId('toolu'),
        name: next.name,
        summary: next.summary,
        input: {},
      }),
    ]);
    backend.updateSession(BE_SESSION, { activity: `${next.name}: ${next.summary}` });
    backend.setMemberState('be-1', 'working', next.activity);
  };

  const qaProgress = (done: number) => {
    const chat = backend.chats[QA_SESSION] ?? [];
    const pending = pendingToolCall(chat);
    if (pending) {
      backend.appendChat(QA_SESSION, [
        backend.chatItem('tool_result', { toolUseId: pending.toolUseId, ok: true, summary: 'kép mentve' }),
      ]);
    }
    if (done < 5) {
      backend.appendChat(QA_SESSION, [
        backend.chatItem('tool_call', {
          toolUseId: mockId('toolu'),
          name: 'mcp__playwright__browser_take_screenshot',
          summary: `${done}. nézet · 390×844`,
          input: {},
        }),
      ]);
      backend.updateSession(QA_SESSION, { activity: `Playwright: ajánló mobilon ${done}/5` });
      backend.setMemberState('qa', 'working', `Ajánló mobilon · ${done}/5`);
      return;
    }
    backend.appendChat(QA_SESSION, [
      backend.chatItem('assistant_text', {
        text: 'Mind az öt mobil nézet rendben. Szólok a Kommunikációnak.',
      }),
    ]);
    backend.sendTeamMessage(
      'qa',
      ['communication'],
      'AC-18',
      'Mind az öt ajánló-nézet rendben mobilon is (390 px). A képernyőképek a PR-ban vannak.',
      QA_SESSION,
    );
    backend.updateSession(QA_SESSION, { state: 'idle', activity: null });
    backend.setMemberState('qa', 'idle', 'Ajánló: mobilon rendben');
  };

  const codeReviewDone = () => {
    const task = backend.findTask('AC-25');
    if (!task || task.stageId !== 'code_review') return;
    const chat = backend.chats[CR_SESSION] ?? [];
    const pending = pendingToolCall(chat);
    if (pending) {
      backend.appendChat(CR_SESSION, [
        backend.chatItem('tool_result', { toolUseId: pending.toolUseId, ok: true, summary: '118 sor' }),
      ]);
    }
    backend.appendChat(CR_SESSION, [
      backend.chatItem('assistant_text', {
        text: 'Nem blokkol. Egy megjegyzés: a PDF-ben a dátum formátuma a nyelvi beállítást kövesse (InvoicePdf.php:57).',
      }),
    ]);
    backend.updateTask('AC-25', {
      stageId: 'integration',
      status: 'waiting',
      checks: { ...task.checks, code_review: 'passed' },
    });
    backend.addTimeline(
      'AC-25',
      'code-review',
      'task_check_changed',
      { check: 'code_review', from: 'pending', to: 'passed' },
      CR_SESSION,
    );
    backend.addTimeline(
      'AC-25',
      'code-review',
      'task_stage_changed',
      { from: 'code_review', to: 'integration' },
      CR_SESSION,
    );
    backend.sendTeamMessage(
      'code-review',
      ['be-1', 'devops'],
      'AC-25',
      'PR #16 nem blokkol, mehet integrationre. 1 megjegyzés: InvoicePdf.php:57, a dátum formátuma.',
      CR_SESSION,
    );
    backend.updateSession(CR_SESSION, { state: 'exited', activity: null, endedAt: nowIso() });
    backend.setMemberState('code-review', 'idle', 'PR #16: nem blokkol');
  };

  const permissionRequest = () => {
    const session = backend.findSession(BE_SESSION);
    if (!session || session.state !== 'working') return;
    const command = 'pg_restore --clean --no-owner --dbname=acme_restore_test /backups/acme-latest.dump';
    const chat = backend.chats[BE_SESSION] ?? [];
    const pending = pendingToolCall(chat);
    if (pending) {
      backend.appendChat(BE_SESSION, [
        backend.chatItem('tool_result', { toolUseId: pending.toolUseId, ok: true, summary: 'rendben' }),
      ]);
    }
    backend.appendChat(BE_SESSION, [
      backend.chatItem('assistant_text', {
        text: 'A próba-adatbázisba visszaállítom a legutóbbi mentést. Ehhez engedély kell, mert adatbázist ír.',
      }),
      backend.chatItem('tool_call', {
        toolUseId: mockId('toolu'),
        name: 'Bash',
        summary: command,
        input: { command },
      }),
    ]);
    const item: InboxItem = {
      id: mockId('inb'),
      projectKey: PROJECT_KEY,
      kind: 'permission',
      assignees: [backend.owner],
      source: 'be-1',
      sessionId: BE_SESSION,
      taskKey: 'AC-20',
      title: `Bash: ${command}`,
      body: null,
      payload: { toolName: 'Bash', toolInput: { command }, summary: command },
      options: [
        { id: 'allow', label: 'allow', style: 'primary' },
        { id: 'allow_session', label: 'allow_session', style: 'secondary' },
        { id: 'deny', label: 'deny', style: 'danger' },
      ],
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    };
    backend.upsertInbox(item);
    backend.addTimeline(
      'AC-20',
      'be-1',
      'permission_requested',
      { inboxItemId: item.id, toolName: 'Bash', summary: 'pg_restore' },
      BE_SESSION,
    );
    backend.updateSession(BE_SESSION, { state: 'waiting_permission', activity: `Bash: ${command}` });
    backend.setMemberState('be-1', 'waiting_for_human', 'Engedélyre vár: pg_restore');
  };

  const loop = () => {
    tick += 1;
    if (tick === 2) qaProgress(4);
    else if (tick === 3) codeReviewDone();
    else if (tick === 4) qaProgress(5);
    else if (tick === 6) permissionRequest();
    else advanceBackend();
    backend.later(6000 + Math.random() * 4000, loop);
  };

  backend.later(3500, loop);
}
