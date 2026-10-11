import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { t } from '../i18n/t';
import {
  alertText,
  approvalHintOf,
  decisionSubject,
  gateThenMergeText,
  inboxHeading,
  questionExtras,
  resolutionLabel,
  resolverName,
  resolutionNote,
  shortCommand,
  splitQuestion,
} from './inbox';

const item: InboxItem = {
  id: 'fictional-inbox',
  projectKey: 'AR',
  kind: 'permission',
  assignees: ['owner'],
  source: 'dev-1',
  sessionId: 'fictional-session',
  taskKey: 'AR-1',
  title: 'Bash: npm ci',
  body: null,
  payload: {},
  options: [],
  state: 'resolved',
  createdAt: '2026-09-30T10:00:00.000Z',
  resolution: { optionId: 'allow', by: 'system', at: '2026-09-30T10:00:00.000Z', note: null },
};

it('shows approval questions closed by the system as approved rather than answered', () => {
  const approved: InboxItem = {
    ...item,
    kind: 'question',
    payload: { question: 'May we merge?', approvalLabel: 'merge-approved' },
    resolution: { ...item.resolution!, optionId: 'ended', rule: 'approval_given' },
  };
  expect(resolutionLabel(approved)).toBe(t('inbox.resolutions.approval_given'));
  expect(resolverName(approved, new Map(), 'owner')).toBe(t('inbox.resolutionRules.approval_given'));
});

describe('approvalHintOf (PM-484)', () => {
  const question: InboxItem = {
    ...item,
    id: 'inb_q',
    kind: 'question',
    state: 'open',
    resolution: null,
    assignees: ['dev-1'],
    payload: { question: 'May we merge?', approvalLabel: 'merge-approved' },
  };
  const gate = (id: string, assignees: string[], label = 'merge-approved'): InboxItem => ({
    ...item,
    id,
    kind: 'decision',
    state: 'open',
    resolution: null,
    assignees,
    payload: {
      gate: {
        requestId: 'gat_1',
        taskKey: 'AR-1',
        fromStageId: 'review',
        toStageId: 'done',
        stageId: 'done',
        label,
        requestedBy: { kind: 'ai', handle: 'dev-1' },
      },
    },
  });
  const task = { labels: ['code-review-ok'] };

  it('says nothing for a question without an approval label or an item that is no open question', () => {
    const plain = { ...question, payload: { question: 'Inline or toast?' } };
    expect(approvalHintOf(plain, { task, items: [], myHandle: 'owner' })).toBeNull();
    expect(
      approvalHintOf({ ...question, state: 'resolved' }, { task, items: [], myHandle: 'owner' }),
    ).toBeNull();
    expect(approvalHintOf(gate('g', ['owner']), { task, items: [], myHandle: 'owner' })).toBeNull();
  });

  it('is done when the label is already on the card', () => {
    const hint = approvalHintOf(question, {
      task: { labels: ['merge-approved'] },
      items: [gate('g', ['owner'])],
      myHandle: 'owner',
    });
    expect(hint).toEqual({ kind: 'done', label: 'merge-approved' });
  });

  it('jumps to the open approval item the viewer may give', () => {
    const hint = approvalHintOf(question, {
      task,
      items: [gate('g_other_label', ['owner'], 'release-approved'), gate('g', ['owner'])],
      myHandle: 'owner',
    });
    expect(hint).toEqual({ kind: 'jump', label: 'merge-approved', gateItemId: 'g' });
  });

  it('names the approvers when the approval is for others', () => {
    const hint = approvalHintOf(question, {
      task,
      items: [gate('g', ['kata', 'owner'])],
      myHandle: 'dev-1',
    });
    expect(hint).toEqual({ kind: 'others', label: 'merge-approved', approvers: ['kata', 'owner'] });
  });

  it('has no request to point at when none is open (rejected, or on another card)', () => {
    const rejected = { ...gate('g', ['owner']), state: 'cancelled' as const };
    const elsewhere = { ...gate('h', ['owner']), taskKey: 'AR-2' };
    const hint = approvalHintOf(question, { task, items: [rejected, elsewhere], myHandle: 'owner' });
    expect(hint).toEqual({ kind: 'none', label: 'merge-approved', taskKey: 'AR-1' });
  });
});

describe('gateThenMergeText (PM-484)', () => {
  const request = (merge?: { merger: string; base: string }): InboxItem => ({
    ...item,
    kind: 'decision',
    state: 'open',
    resolution: null,
    payload: {
      gate: {
        requestId: 'gat_1',
        taskKey: 'AR-1',
        fromStageId: 'review',
        toStageId: 'done',
        stageId: 'done',
        label: 'merge-approved',
        requestedBy: { kind: 'ai', handle: 'dev-1' },
        ...(merge ? { merge } : {}),
      },
    },
  });

  it('says who merges into which branch, and "te" for the viewer', () => {
    const merge = { merger: 'dev-1', base: 'main' };
    expect(gateThenMergeText(request(merge), null, new Map(), 'owner')).toBe(
      t('inbox.gateThenMerge', { merger: 'dev-1', base: 'main', to: 'done' }),
    );
    expect(gateThenMergeText(request(merge), null, new Map(), 'dev-1')).toBe(
      t('inbox.gateThenMergeYou', { base: 'main', to: 'done' }),
    );
  });

  it('leaves the line out when the request names no merge', () => {
    expect(gateThenMergeText(request(), null, new Map(), 'owner')).toBeNull();
  });
});

it('attributes a forwarded owner answer to the integrator', () => {
  const forwarded: InboxItem = {
    ...item,
    kind: 'question',
    resolution: { optionId: 'answer', by: 'owner', via: 'integrator', at: item.createdAt, note: 'Blue' },
  };
  expect(resolverName(forwarded, new Map(), 'owner')).toBe(t('involvement.integratorFull'));
  expect(resolutionNote(forwarded)).toBe(`${t('integratorKey.forwarded')}: Blue`);
});

describe('splitQuestion', () => {
  it('renders a provider quota alert with its message and retry time', () => {
    const quota: InboxItem = {
      ...item,
      kind: 'alert',
      payload: {
        alert: 'provider_rate_limited',
        provider: 'nanogpt',
        weeklyPercent: 100,
        until: '2026-10-06T12:15:00.000Z',
        message: '429 Too Many Requests',
        workItem: { type: 'general' },
      },
    };
    expect(inboxHeading(quota)).toBe(t('inbox.alerts.provider_rate_limited.heading'));
    const text = alertText(quota, new Map(), null);
    expect(text).toContain('NanoGPT');
    expect(text).toContain('429 Too Many Requests');
    expect(text).not.toContain('{until}');
    const unknown = alertText(
      { ...quota, payload: { ...(quota.payload as object), until: null, weeklyPercent: null } },
      new Map(),
      null,
    );
    expect(unknown).toContain('a keret állapotára vár');
    expect(unknown).not.toContain('Újrapróba:');
  });
  it('renders the alert that a new relation has no analyst to check it (PM-421)', () => {
    const alert: InboxItem = {
      ...item,
      kind: 'alert',
      source: 'system',
      payload: {
        alert: 'relation_check',
        taskKey: 'AR-1',
        relations: [
          { kind: 'prerequisite', key: 'AR-2' },
          { kind: 'duplicated_by', key: 'AR-3' },
        ],
      },
    };
    expect(inboxHeading(alert)).toBe(t('inbox.alerts.relation_check.heading'));
    const text = alertText(alert, new Map(), null);
    expect(text).toContain('AR-1');
    expect(text).toContain('AR-2');
    expect(text).toContain('AR-3');
    expect(text).not.toContain('{');
  });
  it('renders the alert that parts were left in the first stage after a reminder (PM-480)', () => {
    const alert: InboxItem = {
      ...item,
      kind: 'alert',
      source: 'system',
      payload: { alert: 'parts_left', taskKey: 'AR-1', member: 'dev-1', parts: ['AR-2', 'AR-3'] },
    };
    expect(inboxHeading(alert)).toBe(t('inbox.alerts.parts_left.heading'));
    const text = alertText(alert, new Map(), null);
    expect(text).toContain('AR-1');
    expect(text).toContain('AR-2, AR-3');
    expect(text).toContain('dev-1');
    expect(text).not.toContain('{');
  });
  it('keeps a short one-line question whole, without marks', () => {
    expect(splitQuestion('Mehet ma este a kiadás az élesbe?')).toEqual({
      title: 'Mehet ma este a kiadás az élesbe?',
      body: null,
    });
    expect(splitQuestion('Mehet **ma este** a `kiadás`?')).toEqual({
      title: 'Mehet ma este a kiadás?',
      body: null,
    });
  });

  it('keeps a short one-line question of two sentences whole', () => {
    const text = 'A teszt lefutott. Mehet a kiadás az élesbe?';
    expect(splitQuestion(text)).toEqual({ title: text, body: null });
  });

  it('keeps a short date-led question whole as its heading', () => {
    const text = '2026. október 10-ig kiadhatjuk?';
    expect(splitQuestion(text)).toEqual({ title: text, body: null });
    expect(inboxHeading({ ...item, kind: 'question', title: text })).toBe(text);
    expect(splitQuestion('1. Release now?')).toEqual({ title: null, body: '1. Release now?' });
  });

  it('ends the title at the first question mark and keeps the rest as the body', () => {
    const text =
      'Kidolgozás alatt mi legyen a fiókban az Indítás gombbal? Minden gazdátlan kártyán megjelenik.\n\n- Egy\n- Két';
    expect(splitQuestion(text)).toEqual({
      title: 'Kidolgozás alatt mi legyen a fiókban az Indítás gombbal?',
      body: 'Minden gazdátlan kártyán megjelenik.\n\n- Egy\n- Két',
    });
  });

  it('does not cut inside emphasis: the title runs to its end', () => {
    const text =
      '**Mi alapján van ott ma az Indítás?** Minden kártyán megjelenik, a kapukat nem nézi.\nMásodik sor.';
    expect(splitQuestion(text)).toEqual({
      title: 'Mi alapján van ott ma az Indítás?',
      body: 'Minden kártyán megjelenik, a kapukat nem nézi.\nMásodik sor.',
    });
  });

  it('keeps a closing quote with the title', () => {
    expect(
      splitQuestion('Mit jelent a „Kész”-állapot, ha nincs minden zöld? „Kész” a cél.\nTovább.'),
    ).toEqual({
      title: 'Mit jelent a „Kész”-állapot, ha nincs minden zöld?',
      body: '„Kész” a cél.\nTovább.',
    });
  });

  it('ignores a question mark inside code or a link, and one past the limit', () => {
    expect(splitQuestion('A `a?b` kifejezés jó. Ezt hogyan tegyük át?\nRészlet.').title).toBe(
      'A a?b kifejezés jó. Ezt hogyan tegyük át?',
    );
    expect(splitQuestion('Lásd [ez a kérdés?](https://example.test/q) itt. Folytatás.\nRészlet.').title).toBe(
      'Lásd ez a kérdés? itt.',
    );
    const late = `${'x'.repeat(230)} vége? Utána.\nRészlet.`;
    expect(splitQuestion(late).title).toBe(`${'x'.repeat(230)} vége? Utána.`);
  });

  it('does not end a sentence at a date, an abbreviation or inside a word', () => {
    expect(splitQuestion('A kiadás 2026. október elsején lesz. Utána jön a többi.\nRészlet.').title).toBe(
      'A kiadás 2026. október elsején lesz.',
    );
    expect(splitQuestion('Több lehetőség van, pl. A vagy B, a v1.2 verzióban\nRészlet.').title).toBe(
      'Több lehetőség van, pl. A vagy B, a v1.2 verzióban',
    );
  });

  it('ends a long first line without a question mark at its first sentence', () => {
    const text =
      'A régi kártyákon minden marad, ahogy ma. Ezt a szabályt csak az új kártyákra tennénk be.\nRészlet.';
    expect(splitQuestion(text)).toEqual({
      title: 'A régi kártyákon minden marad, ahogy ma.',
      body: 'Ezt a szabályt csak az új kártyákra tennénk be.\nRészlet.',
    });
  });

  it('takes the whole first line as the title when it has no mark at all', () => {
    const line = `${'szó '.repeat(50)}vége`;
    expect(splitQuestion(`${line}\nRészlet.`)).toEqual({ title: line, body: 'Részlet.' });
  });

  it('takes a heading line as the title', () => {
    expect(splitQuestion('## Melyik **terv** legyen?\nAz A olcsóbb.')).toEqual({
      title: 'Melyik terv legyen?',
      body: 'Az A olcsóbb.',
    });
  });

  it('gives a question that starts with a list or a code block no title', () => {
    const list = '- Az alsó sáv 64 px magas.\n- A számláló az ikonon ül.\n\nMaradhat így?';
    expect(splitQuestion(list)).toEqual({ title: null, body: list });
    const code = '```\nnpm test\n```\nMehet?';
    expect(splitQuestion(code)).toEqual({ title: null, body: code });
  });

  it('treats a short one-line question that starts with a list mark as a list', () => {
    expect(splitQuestion('- Maradhat így?')).toEqual({ title: null, body: '- Maradhat így?' });
  });

  it('treats a short one-line question that starts with a heading mark as a heading', () => {
    expect(splitQuestion('# Indítás')).toEqual({ title: 'Indítás', body: null });
  });

  it('gives the question a fallback heading when it has no title', () => {
    const entry: InboxItem = { ...item, kind: 'question', title: '- Egy\n- Kettő\n\nMaradhat?' };
    expect(inboxHeading(entry)).toBe(t('inbox.question.untitled'));
    expect(inboxHeading({ ...entry, title: '**Mehet?** Ez a háttér.\nMég egy sor.' })).toBe('Mehet?');
  });
});

describe('shortCommand', () => {
  it.each([
    ['git push origin HEAD', 'git push'],
    ['cd /x/y && grep -rn example . | head', 'grep'],
    ['cd /x && git commit -m "Example"', 'git commit'],
    ["cd '/x/y with spaces' && npm ci", 'npm ci'],
    ['cd "/x/y with spaces" && git status', 'git status'],
    ['cd /x && cd "y z" && npx vitest run', 'npx'],
    ['  cd /x&& git diff  ', 'git diff'],
    ['cd /x/y', 'cd'],
    ['cd /x; git push', 'cd'],
    ['cd /x || git push', 'cd'],
    ['grep -rn example .', 'grep'],
    ['npm --version', 'npm'],
  ])('summarizes %s as %s', (command, expected) => {
    expect(shortCommand(command)).toBe(expected);
  });
  it('handles empty and long commands', () => {
    expect(shortCommand(null)).toBeNull();
    expect(shortCommand('')).toBeNull();
    expect(shortCommand('a'.repeat(40))).toBe(`${'a'.repeat(31)}…`);
  });
});

describe('automatic permission resolution labels', () => {
  it.each(['allow', 'deny'] as const)('labels automatic %s decisions', (optionId) => {
    expect(resolutionLabel({ ...item, resolution: { ...item.resolution!, optionId } })).toBe(
      t(`inbox.resolutions.automatic_${optionId}`),
    );
    expect(resolutionLabel({ ...item, resolution: { ...item.resolution!, optionId, by: 'owner' } })).toBe(
      t(`inbox.resolutions.${optionId}`),
    );
  });
});

describe('decisionSubject', () => {
  it('uses the plain short question heading in history', () => {
    expect(
      decisionSubject({
        ...item,
        kind: 'question',
        title: '**Release now?** Background.\n- First\n- Second',
      }),
    ).toBe('Release now?');
  });

  it('uses the fallback heading for a question starting with a list', () => {
    expect(decisionSubject({ ...item, kind: 'question', title: '- First\n- Second' })).toBe(
      t('inbox.question.untitled'),
    );
  });
});

describe('questionExtras', () => {
  const question: InboxItem = {
    ...item,
    kind: 'question',
    title: 'Inline or toast?',
    payload: {
      question: 'Inline or toast?',
      options: ['Inline', 'Toast'],
      recommended: 'option_2',
      recommendationReason: ' It stays visible. ',
      details: ' The `EmailField` already shows inline errors. ',
    },
    options: [
      { id: 'option_1', label: 'Inline', style: 'secondary' },
      { id: 'option_2', label: 'Toast', style: 'primary' },
      { id: 'answer', label: 'answer', style: 'secondary' },
    ],
    state: 'open',
    resolution: null,
  };

  it('reads the recommended option, its reason and the details', () => {
    expect(questionExtras(question)).toEqual({
      recommendedOptionId: 'option_2',
      recommendationReason: 'It stays visible.',
      details: 'The `EmailField` already shows inline errors.',
    });
  });

  it('has nothing for a question from before these fields existed', () => {
    const old = { ...question, payload: { question: 'Inline or toast?', options: ['Inline', 'Toast'] } };
    expect(questionExtras(old)).toEqual({
      recommendedOptionId: null,
      recommendationReason: null,
      details: null,
    });
  });

  it('leaves out a recommendation of an option the item does not have, and its reason', () => {
    const dangling = { ...question, payload: { ...question.payload, recommended: 'option_9' } };
    expect(questionExtras(dangling)).toMatchObject({ recommendedOptionId: null, recommendationReason: null });
    expect(questionExtras(dangling).details).toBe('The `EmailField` already shows inline errors.');
  });

  it('leaves out blank text and an unreadable payload', () => {
    const blank = {
      ...question,
      payload: { ...question.payload, recommendationReason: '  ', details: '\n' },
    };
    expect(questionExtras(blank)).toEqual({
      recommendedOptionId: 'option_2',
      recommendationReason: null,
      details: null,
    });
    const unreadable = { ...question, payload: { question: 'Inline or toast?', details: 42 } };
    expect(questionExtras(unreadable).details).toBeNull();
  });

  it('has nothing on other kinds of items', () => {
    expect(questionExtras({ ...item, payload: { ...question.payload } })).toEqual({
      recommendedOptionId: null,
      recommendationReason: null,
      details: null,
    });
  });
});
