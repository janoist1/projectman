import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { t } from '../i18n/t';
import { inboxHeading, questionExtras, resolutionLabel, shortCommand, splitQuestion } from './inbox';

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

describe('splitQuestion', () => {
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
