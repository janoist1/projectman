import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEmbedder } from './embedder';
import { DEFAULT_MIN_COSINE } from './index';
import { readModelManifest } from './model';

const MODEL_DIRECTORY = fileURLToPath(new URL('../../models/history', import.meta.url));
const modelPrepared = existsSync(`${MODEL_DIRECTORY}/manifest.json`);

/** Each question, the passage that answers it in other words, and passages about something else. */
const CASES: { question: string; related: string; unrelated: string[] }[] = [
  {
    question: 'Hogyan lehet visszavonni egy elfogadott döntést?',
    related: 'A tulajdonos új döntéssel felülírhatja a korábbit; a régi bejegyzés megmarad a naplóban.',
    unrelated: ['A bejelentkezési kód hat számjegyű, és tíz percig érvényes.', 'A banánt a boltban vettem.'],
  },
  {
    question: 'Miért lassú a kártyák betöltése?',
    related:
      'A tábla lekérdezése indexek nélkül minden kártyát végigolvasott, ezért nagy projektben másodpercekig tartott.',
    unrelated: [
      'A hálózati kapcsolat megszakadásakor a felület újracsatlakozik.',
      'Szerdán csapatépítő ebéd lesz.',
    ],
  },
  {
    question: 'Ki dönti el, hogy mi kerül a kiadásba?',
    related: 'A kiadást a tulajdonos hagyja jóvá az alkalmazásban; addig semmi sem kerül az éles példányra.',
    unrelated: ['A képernyőképek a sötét témát használják.', 'A tesztek száma 400 fölé nőtt.'],
  },
  {
    question: 'How do we keep passwords safe?',
    related:
      'Credentials are never stored in task text; secrets live in the secrets folder and are hashed at rest.',
    unrelated: ['The sprint review is on Friday afternoon.', 'The web app uses a dark theme by default.'],
  },
  {
    question: 'What happens when a member runs out of quota?',
    related: 'When the subscription limit is reached the session is paused until the usage window resets.',
    unrelated: ['The footer shows the application version.', 'Labels are grouped by color on the board.'],
  },
  {
    question: 'Mi történik, ha két kártya ugyanazt a fájlt módosítja?',
    related: 'Az összefésülés ütközésnél visszaadja a kártyát a fejlesztőnek, hogy oldja fel a konfliktust.',
    unrelated: [
      'A jelszó legalább tizenkét karakter hosszú legyen.',
      'Az értesítések a böngészőben jelennek meg.',
    ],
  },
  {
    question: 'Hol találom a telepítési útmutatót?',
    related:
      'A kiadás lépései a docs/DEPLOY.md fájlban vannak leírva, a szolgáltatás indításától a visszagörgetésig.',
    unrelated: [
      'A kártya leírása legfeljebb húszezer karakter lehet.',
      'A heti összefoglaló pénteken készül.',
    ],
  },
  {
    question: 'Why was the reviewer unable to approve the change?',
    related:
      'The review was blocked because the branch had conflicts with main, so the approval label could not be set.',
    unrelated: [
      'The calendar view shows the schedule of the week.',
      'Emails are sent through a transactional provider.',
    ],
  },
  {
    question: 'Mennyi memóriát használ a szerver?',
    related: 'A folyamat nyugalmi állapotban körülbelül hatszáz megabájt, a halom (heap) ebből csak hatvan.',
    unrelated: [
      'A felhasználói felület magyar nyelvű, az angol csak a kódban él.',
      'A meghívó hét napig érvényes.',
    ],
  },
  {
    question: 'Can clients see internal notes?',
    related: 'Notes marked as internal are hidden from client accounts; only the team members read them.',
    unrelated: ['The build produces a single JavaScript bundle.', 'Release notes are written in Hungarian.'],
  },
  {
    question: 'Milyen sorrendben futnak a tesztek az összefésülés előtt?',
    related:
      'Az összefésülés a teljes ellenőrzést futtatja az eredményen, és csak sikeres futás után mozdul a főág.',
    unrelated: [
      'A színek kontrasztja megfelel az AA szintnek.',
      'A csapat tagjai külön munkamenetben dolgoznak.',
    ],
  },
  {
    question: 'Is there a limit on the length of a team message?',
    related:
      'A message body may be at most twenty thousand characters; longer text is refused with an error.',
    unrelated: [
      'The project key is two to five capital letters.',
      'Screenshots are stored next to the feedback marks.',
    ],
  },
];

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + value * b[i]!, 0);

describe.skipIf(!modelPrepared)('the pinned model (needs `npm run prepare:history-model`)', () => {
  it(
    'separates the passages that answer a question from the others at the default threshold',
    { timeout: 120_000 },
    async () => {
      const manifest = readModelManifest(MODEL_DIRECTORY);
      const embedder = await createEmbedder(MODEL_DIRECTORY, manifest);
      const related: number[] = [];
      const unrelated: number[] = [];
      for (const item of CASES) {
        const question = await embedder.embedQuery(item.question);
        related.push(dot(question, await embedder.embedPassage(item.related)));
        for (const text of item.unrelated) unrelated.push(dot(question, await embedder.embedPassage(text)));
      }
      // Calibration of DEFAULT_MIN_COSINE: related 0.79–0.87, unrelated 0.70–0.82 on this set. e5 scores are
      // compressed, so the threshold is a precision choice: no unrelated passage passes, at least 80% of the related do.
      expect(unrelated.filter((score) => score >= DEFAULT_MIN_COSINE)).toEqual([]);
      expect(related.filter((score) => score >= DEFAULT_MIN_COSINE).length).toBeGreaterThanOrEqual(
        Math.ceil(related.length * 0.8),
      );
    },
  );
});
