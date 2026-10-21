#!/usr/bin/env node
// Synthetic fixture for the history semantic profile (PM-913, docs/HYBRID.md "History semantic profile").
// The release measurement needs a history about the size of the live one, and no live text may leave the owner's
// machine, so this builds one from a seeded generator: the same seed and the same docs give the same file.
// No dependencies.
//
//   node history-semantic-fixture.mjs --docs <repo docs dir> --out <json file> [--seed 913]
//
// The shape follows the live history counted on 2026-10-21 (the integrator, PM-913): 17 955 sources of about
// 1 000 characters each (a source's length is spread from a quarter to one and three quarters of its type's
// mean), made of 1 000 cards (`task`), 9 200 team messages (`message`), the rest task notes (`note`) and answered
// questions (`question`), and the two supported project documents. The ~48 000 timeline events of the live
// database are mostly not history sources, so none are made. The text is a mix of Hungarian and English.
//
// The 20 questions are the fixed set of the PM-767 recall test (apps/server/test/history-semantic-recall.test.ts),
// each asking for one decision of docs/DECISIONS.md in other words; the target is a note that holds that decision's
// text (the repository is public). The filler around them is generated from small vocabularies of everyday
// project talk; it is not about the decisions, so the recall of the 20 is a real test of the search by meaning.
// The 5 negative controls are off-topic questions.

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SEED = 913;
export const PROJECT_KEY = 'FX';

/** The live counts (see above); `documents` are the two project documents, made from the docs folder. */
export const LIVE_COUNTS = { tasks: 1000, messages: 9200, notes: 7000, questions: 753 };
/** The mean length in characters per type, chosen so the whole set averages about 1 000. */
const MEAN_LENGTH = { task: 1800, note: 1250, question: 900, message: 750 };

/** A question that says what the decision says in other words, and the decision that answers it. */
export const QUESTIONS = [
  { question: 'Is it allowed to pay per request for the AI model usage?', decision: 1 },
  { question: 'Miért nem GitHub Projectsben vezetjük a feladatokat?', decision: 9 },
  { question: 'Milyen nyelven írjuk a kódot, és milyen nyelvű a felület?', decision: 10 },
  { question: "Does merging a change restart the owner's running instance?", decision: 20 },
  { question: 'Is there an upper limit on how many AI sessions run simultaneously?', decision: 23 },
  { question: 'Ki jelölhet duplikátumnak egy még el nem kezdett kártyát?', decision: 29 },
  { question: 'What happens to a heavy command when the queue is unusable?', decision: 33 },
  { question: 'Hogyan nevezzük el a kiadások címkéit a verziókezelőben?', decision: 35 },
  { question: 'Is the virtual machine approach still being pursued?', decision: 36 },
  { question: 'Were old commits of the public repository altered to hide a customer?', decision: 39 },
  { question: 'Hányszor fut le a teljes tesztcsomag egy kártya életében?', decision: 40 },
  { question: 'Can one member be cut off from the internet individually?', decision: 41 },
  { question: 'Mennyi ideje van a korábbi felelősnek átadási jegyzetet írni?', decision: 43 },
  { question: 'Does the system itself integrate finished work into the main branch?', decision: 47 },
  { question: 'Kinek megy egy üzenet, ha a kártyán senki sincs?', decision: 49 },
  { question: 'Where is the board hosted and behind what access layer?', decision: 51 },
  { question: 'Miért Operátornak hívják kifelé az integrátort?', decision: 52 },
  { question: 'What should the application never do by itself, like writing code?', decision: 48 },
  { question: 'Who is woken when an AI posts a card message?', decision: 44 },
  { question: 'Hogyan kapcsolódik a NanoGPT, és melyik titokhoz fér hozzá?', decision: 34 },
];

/** Questions about nothing the history holds: none of them should bring a hit by meaning. */
export const NEGATIVES = [
  'How long should sourdough bread rise before baking?',
  'Mi a legjobb módszer a balatoni horgászatra?',
  'What is the capital of Australia?',
  'Recommend a good movie about space travel',
  'Hány fok van ma Budapesten?',
];

// ---------- the seeded generator ----------

/** mulberry32: a small, fast, seeded generator (the same seed gives the same sequence). */
export function createRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  return { next, int, pick };
}

// Everyday project talk. The areas and phrases are deliberately about product work (screens, imports, invoices,
// dates), not about how the team works, so they do not answer the decisions' questions.
const AREAS = {
  hu: [
    'a számlázó modul',
    'az ügyféllista',
    'a naptár nézet',
    'az exportálás',
    'a jelszó-visszaállító oldal',
    'a PDF-generálás',
    'az értesítési beállítások',
    'a termékkatalógus',
    'a raktárkészlet-képernyő',
    'az árazási táblázat',
    'a térképes nézet',
    'a CSV-importáló',
    'a mobilos menü',
    'a jelentéskészítő',
    'a szállítási cím űrlap',
    'a kuponkezelő',
    'a nyelvváltó',
    'az adatlap szerkesztője',
  ],
  en: [
    'the invoice screen',
    'the customer list',
    'the calendar view',
    'the export dialog',
    'the password reset page',
    'the PDF renderer',
    'the notification settings',
    'the product catalog',
    'the stock overview',
    'the pricing table',
    'the map widget',
    'the CSV importer',
    'the mobile menu',
    'the report builder',
    'the shipping address form',
    'the coupon editor',
    'the language switcher',
    'the profile editor',
  ],
};

const PROBLEMS = {
  hu: [
    'lassan tölt be, ha sok sor van a táblázatban',
    'rossz dátumot mutat a hónap utolsó napján',
    'a sorrend összekeveredik, ha két oszlopot rendezünk',
    'üres marad a mező, amíg újra nem töltjük az oldalt',
    'kétszer jeleníti meg ugyanazt az elemet',
    'levágja az ékezetes betűket a mentés után',
    'túl szűk a kijelzőn a gombok közötti hely',
    'nem frissül a végösszeg a tétel törlése után',
    'a szűrő nem emlékszik az utolsó beállításra',
    'hibás a kerekítés a második tizedesnél',
    'az időzóna miatt egy nappal korábbra kerül az esemény',
    'a betöltő animáció nem tűnik el',
  ],
  en: [
    'loads slowly when the table has many rows',
    'shows the wrong date on the last day of the month',
    'mixes up the order when two columns are sorted',
    'stays empty until the page is reloaded',
    'renders the same entry twice',
    'cuts off accented letters after saving',
    'leaves too little room between the buttons on a small screen',
    'does not update the total after a line is removed',
    'forgets the last filter the user picked',
    'rounds wrongly at the second decimal',
    'moves the event one day earlier because of the time zone',
    'never hides its loading spinner',
  ],
};

const ACTIONS = {
  hu: [
    'Átírtam a lekérdezést, hogy lapozva dolgozzon',
    'Kipróbáltam egy másik számformátumot',
    'Visszavontam az utolsó stíluslépést',
    'Megnéztem a mintaadatokkal is, ugyanez történik',
    'Felvettem egy ellenőrző példát a hibához',
    'Egyeztettem a kolléganővel a pontos elvárásról',
    'Összehasonlítottam a két böngésző viselkedését',
    'Egyszerűsítettem a komponens állapotkezelését',
    'Hozzáadtam egy rövid magyarázatot a mezőhöz',
    'Újraírtam a segédfüggvényt, mert túl bonyolult volt',
  ],
  en: [
    'I rewrote the query so it works page by page',
    'I tried another number format',
    'I reverted the last styling step',
    'I checked it with the sample data too and the same thing happens',
    'I added a worked example for the bug',
    'I confirmed the exact expectation with the customer contact',
    'I compared how the two browsers behave',
    'I simplified how the component keeps its state',
    'I added a short hint next to the field',
    'I rewrote the helper because it had grown too complicated',
  ],
};

const FOLLOW_UPS = {
  hu: [
    'Holnap délelőtt újra ránézek.',
    'Ha valakinek van jobb ötlete, szívesen veszem.',
    'A következő lépés a kézi kipróbálás lesz.',
    'Ezt még egyeztetni kell az ügyféllel.',
    'Szerintem ez nem sürgős, de zavaró.',
    'A részletek a mellékelt példában vannak.',
    'Egyelőre nem találtam okot, megyek tovább.',
    'Jó lenne rövid leírást is készíteni hozzá.',
  ],
  en: [
    'I will look at it again tomorrow morning.',
    'If anyone has a better idea, I would be glad to hear it.',
    'The next step is trying it by hand.',
    'This still has to be agreed with the customer.',
    'I do not think it is urgent, but it is annoying.',
    'The details are in the attached example.',
    'I have found no cause so far and will move on.',
    'A short write-up would be good for this as well.',
  ],
};

const TITLE_FORMS = {
  hu: ['{area}: {problem}', 'Javítandó: {area}', 'Finomítás: {area}', 'Ügyfélkérés: {area}'],
  en: ['{area}: {problem}', 'Fix: {area}', 'Polish: {area}', 'Customer request: {area}'],
};

const fill = (form, values) => form.replace(/\{(\w+)\}/g, (_, name) => values[name]);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** One sentence of everyday talk in `lang`; `rng` decides the parts, so the text is reproducible. */
function sentence(rng, lang) {
  const area = rng.pick(AREAS[lang]);
  const problem = rng.pick(PROBLEMS[lang]);
  const number = 1 + rng.int(400);
  switch (rng.int(5)) {
    case 0:
      return lang === 'hu'
        ? `${capitalize(area)} ${problem} (${number}. sor körül).`
        : `${capitalize(area)} ${problem} (around line ${number}).`;
    case 1:
      return `${rng.pick(ACTIONS[lang])}.`;
    case 2:
      return lang === 'hu'
        ? `A ${number} ms-os válaszidő mellett ${area} még elfogadható.`
        : `With a response time of ${number} ms, ${area} is still acceptable.`;
    case 3:
      return rng.pick(FOLLOW_UPS[lang]);
    default:
      return lang === 'hu'
        ? `${capitalize(area)} esetében ${rng.pick(PROBLEMS.hu)}, ezt a ${1 + rng.int(28)}-i kiadás előtt rendezni kell.`
        : `For ${area}, it ${rng.pick(PROBLEMS.en)}; this has to be sorted before the release on the ${1 + rng.int(28)}th.`;
  }
}

/** The language of a source: mostly one language, sometimes a mix (every sentence picks its own). */
const languageOf = (rng) => {
  const roll = rng.next();
  return roll < 0.5 ? 'hu' : roll < 0.8 ? 'en' : 'mixed';
};

/** Text of about `target` characters (never an empty body). */
function paragraph(rng, lang, target) {
  const parts = [];
  let length = 0;
  while (length < target) {
    const text = sentence(rng, lang === 'mixed' ? rng.pick(['hu', 'en']) : lang);
    parts.push(text);
    length += text.length + 1;
  }
  return parts.join(' ');
}

const titleOf = (rng, lang) => {
  const language = lang === 'mixed' ? rng.pick(['hu', 'en']) : lang;
  return capitalize(
    fill(rng.pick(TITLE_FORMS[language]), {
      area: rng.pick(AREAS[language]),
      problem: rng.pick(PROBLEMS[language]),
    }),
  );
};

/** A length from a quarter to one and three quarters of `mean`: the mean of the set stays `mean`. */
const lengthAround = (rng, mean) => Math.round(mean * (0.25 + 1.5 * rng.next()));

function fillerSource(rng, type, index) {
  const lang = languageOf(rng);
  const body = paragraph(rng, lang, lengthAround(rng, MEAN_LENGTH[type]));
  // Task notes and messages have no title of their own in the live data; the other two do.
  const title = type === 'task' || type === 'question' ? titleOf(rng, lang) : '';
  return { id: `${type}-${String(index + 1).padStart(5, '0')}`, type, title, body };
}

// ---------- the real documents ----------

/** The numbered decisions of docs/DECISIONS.md as `{ number, title, body }` (the same split as the recall test). */
export function parseDecisions(text) {
  return text
    .split(/^(?=\d+\. \*\*)/m)
    .filter((part) => /^\d+\. \*\*/.test(part))
    .map((part) => {
      const number = Number(/^(\d+)\./.exec(part)[1]);
      const [title = '', ...rest] = part.trim().split('\n');
      return { number, title: title.slice(0, 200), body: rest.join('\n').trim() };
    });
}

const DOCUMENTS = [
  { id: 'document-decisions', file: 'DECISIONS.md', path: 'docs/DECISIONS.md' },
  { id: 'document-lessons', file: 'LESSONS.md', path: 'docs/LESSONS.md' },
];

/**
 * The fixture object. `docsDir` holds DECISIONS.md and LESSONS.md; `counts` overrides `LIVE_COUNTS` (a test builds a
 * small one). The 20 target notes are part of `notes`, so the total of the counts is the size of the filler.
 */
export function buildFixture({ docsDir, seed = DEFAULT_SEED, counts = LIVE_COUNTS }) {
  const documents = DOCUMENTS.map((doc) => ({
    ...doc,
    text: readFileSync(join(docsDir, doc.file), 'utf8'),
  }));
  const decisions = parseDecisions(documents[0].text);
  const rng = createRandom(seed);
  const sources = [];

  const targets = QUESTIONS.map((item) => {
    const decision = decisions.find((d) => d.number === item.decision);
    if (!decision) throw new Error(`docs/DECISIONS.md has no decision ${item.decision}`);
    return {
      item,
      source: {
        id: `decision-${decision.number}`,
        type: 'note',
        title: '',
        body: decision.title + '\n' + decision.body,
      },
    };
  });
  for (const { source } of targets) sources.push(source);

  const filler = [
    ['task', counts.tasks],
    ['message', counts.messages],
    ['note', Math.max(0, counts.notes - targets.length)],
    ['question', counts.questions],
  ];
  for (const [type, count] of filler)
    for (let index = 0; index < count; index += 1) sources.push(fillerSource(rng, type, index));
  for (const doc of documents)
    sources.push({ id: doc.id, type: 'document', path: doc.path, title: '', body: doc.text });

  // A stable shuffle, so the target notes do not all lie at the start of the history.
  for (let i = sources.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    [sources[i], sources[j]] = [sources[j], sources[i]];
  }

  return {
    schemaVersion: 1,
    origin:
      `Synthetic (seeded generator deploy/cloud/history-semantic-fixture.mjs, seed ${seed}, PM-913): ` +
      `${sources.length} sources of mixed Hungarian and English filler sized after the live history of 2026-10-21 ` +
      `(${counts.tasks} cards, ${counts.messages} messages, ${counts.notes} notes, ${counts.questions} questions, ` +
      `the two project documents). The 20 target notes are decisions of the public docs/DECISIONS.md. ` +
      `No live history text is in it.`,
    project: { key: PROJECT_KEY },
    sources,
    questions: targets.map(({ item, source }) => ({ question: item.question, targetId: source.id })),
    negatives: NEGATIVES.map((question) => ({ question })),
  };
}

// ---------- the command line ----------

export function parseArgs(argv) {
  const values = { seed: String(DEFAULT_SEED) };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--docs', '--out', '--seed'].includes(flag) || value === undefined)
      throw new Error(
        `usage: history-semantic-fixture.mjs --docs <dir> --out <file> [--seed <integer>] (got ${flag})`,
      );
    values[flag.slice(2)] = value;
  }
  if (!values.docs || !values.out) throw new Error('--docs and --out are required');
  if (!/^\d+$/.test(values.seed)) throw new Error('--seed must be a non-negative integer');
  return { docsDir: resolve(values.docs), out: resolve(values.out), seed: Number(values.seed) };
}

export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 64;
  }
  if (!isAbsolute(options.out)) return 64;
  const fixture = buildFixture({ docsDir: options.docsDir, seed: options.seed });
  writeFileSync(options.out, JSON.stringify(fixture), { mode: 0o600 });
  const bytes = fixture.sources.reduce((sum, s) => sum + s.title.length + s.body.length, 0);
  process.stdout.write(
    `${fixture.sources.length} sources, ${bytes} characters, ${fixture.questions.length} questions -> ${options.out}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
