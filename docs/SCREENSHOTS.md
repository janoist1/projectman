# Screenshots for the team members (PM-270)

A member (the UI/UX designer, QA) puts before-and-after images on a card and reproduces a bug
step by step. `npm run shots` does it in one command, inside the member's own sandbox:

1. a disposable instance starts (`scripts/lib/instance.mjs`, PM-269: server, Vite, fake CLIs, demo
   data in a temporary folder, free ports);
2. the member's scenario runs in a headless Chromium;
3. the images are written;
4. everything stops and the data is removed.

Nothing touches `~/.projectman` or port 4800 (the live instance).

## Once: install the browser

A person runs this in a normal terminal, **outside** any member's sandbox. It downloads the
`chromium-headless-shell` that matches the pinned `playwright-core`:

```sh
npm run browsers -- install   # on Linux it also installs the system libraries (--with-deps)
npm run browsers -- check     # says whether it is there, and which version
```

The browsers folder is `$PROJECTMAN_BROWSERS_PATH`, else `$PLAYWRIGHT_BROWSERS_PATH`, else
`~/.projectman/browsers`. The server hands a member's session the folder it was started with as
`PLAYWRIGHT_BROWSERS_PATH`, read-only (PM-268, PROVIDERS.md), so `npm run shots` finds it there. If
the browser is missing, `npm run shots` exits with code 2 and says to run
`npm run browsers -- install`.

## Run

```sh
npm run shots -- <scenario.mjs> [--out <dir>] [--widths 1512,800,390,375] [--full-page] \
                 [--scale 1|2] [--timeout 240] [--seed demo|none] [--keep-data] [--machine <file>]
```

| Option        | Meaning                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--out`       | Folder of the images. Default `$PROJECTMAN_SESSION_DIR/shots/<scenario name>`, else `<tmp>/projectman-shots/<scenario name>` |
| `--widths`    | Default widths of `shoot`, comma separated (default `1512,800,390,375`)                                                      |
| `--full-page` | `shoot` captures the whole page by default                                                                                   |
| `--scale`     | Device pixel ratio, 1 (default) or 2                                                                                         |
| `--timeout`   | Seconds for the whole run, instance start included (default 240)                                                             |
| `--seed`      | `demo` (default: the Acme webshop, project AC, four cards) or `none` (an empty instance)                                     |
| `--keep-data` | Keep the instance's data folder (its path is printed) instead of removing it                                                 |
| `--machine`   | A JSON file of a fixed machine for the machine display (see below), e.g. `scripts/fixtures/machine/busy.json`                |

### A fixed machine for the machine display

The machine display (PM-300) measures the real machine with `ps`, which a member's sandbox does not
allow, so pictures of it use fixed data. `--machine <file>` starts the instance's server with
`PROJECTMAN_MACHINE_FIXTURE=<the file's JSON>`: the server then answers `GET /api/machine` from
the file, logs a warning at start, and **never sends a real signal** (stopping an orphan only removes it
from the list). Two samples: `scripts/fixtures/machine/busy.json` (critical load, two orphan processes)
and `calm.json` (everything in order, no orphans).

The JSON has `machine` (`cpuPercent` of the whole machine, `cores`, `memoryUsedGb`, `memoryTotalGb`,
`memoryPressure` `normal|warn|critical`, `swapUsedGb`, `swapTotalGb`; null is unknown), `server`
(`cpuPercent`, `memoryMb`), `sessions` (one per running session, in the order the runner lists them: its
`processes`, the first is the CLI and the rest its children), `others` (processes of no session, grouped by
short name like the real ones) and `orphans` (`sessionId`, which may name a real session of the instance, and
`processes`, the first is the root). A process is `args` (the command line), `cpuPercent` (of one core, as
`ps` shows it), `memoryMb` and `ageMinutes`. The sessions' rows come from the instance's real sessions, so
start them (`instance.startSession`) before the scenario opens the panel.

Exit code: **0** done, **1** the scenario failed (or the instance, or the timeout), **2** wrong
use or no browser.

The output has one line per image, `shot <path> <width>x<height>` (the size of the PNG), a line
`step <n>: <title>` per step, and `blocked <url>` for a request the fence refused.

## The scenario

A scenario is an ES module whose default export is an async function:

```js
export default async ({ instance, open, shoot, snapshot, step, log }) => {
  /* ... */
};
```

A scenario may also export `fakeEnv`, an object of `FAKE_CLAUDE_*` / `FAKE_CODEX_*` variables for the
fake CLIs of its instance (for example `{ FAKE_CLAUDE_LOGGED_OUT: '1' }`:
`scripts/scenarios/provider-not-logged-in.mjs`). Variables of the shell running `npm run shots` never
reach the fake CLIs.

- `instance` is the running disposable instance: `instance.api(path, { method, body, as })`,
  `invite`, `startSession`, `say`, `waitIdle`, `setFakeCalls` and the rest of PM-269's API. Use it
  to prepare the state (a card, a question, an invited user) before the browser looks at it.
- `open({ as?, path?, width? })` opens a page and returns its `Page`. `as` is an `Account` (the
  owner by default; `instance.invite(...)` returns one), `path` an instance path such as
  `/p/AC/tasks/AC-1` (default `/`), `width` the first viewport width (default 1512). The login goes
  through the API (the session cookie is put into the browser), so the page opens logged in. The
  browser is Hungarian (`hu-HU`, `Europe/Budapest`), blocks service workers and downloads.
  There is **one browser context** for the whole run (the single-process Chromium crashes on a
  second one, see "Limits"). Pages of the same account live side by side. `open` as **another
  account** closes every page that is open (popups too), clears the cookies and the page storage,
  and logs in again: so a scenario shows two users **one after the other**, never at the same time.
- `shoot(page, name, { widths?, fullPage?, highlight?, mask? })` writes `<out>/<name>-<width>.png`
  for each width and returns the paths. `name` is letters, digits, `.`, `_`, `-`.
  - The viewport heights are fixed per width: 1512×982, 800×900, 390×844, 375×667 (another width
    gets 900).
  - It waits for the fonts and for the network to go quiet, and switches animations and the text
    caret off.
  - `highlight` is a selector (a CSS selector, or a Playwright one such as
    `text=Which colour >> visible=true`); the first match is scrolled into view (a card's drawer
    scrolls too) and gets a 3 px outline in the image only.
  - `mask` is a list of selectors; their boxes are painted grey. Mask what must not leave the
    instance or what changes between runs (times, ids).
- `snapshot(page)` returns the page's accessibility tree as text (`ariaSnapshot`) for checks in
  words, without an image.
- `step(title, fn)` names a part of the scenario. If `fn` throws, `error-<n>.png` is written (the
  last open page) and the error is thrown on as `Step <n> "<title>" failed: ...`, so the exit code
  is 1 and the message names the step.
- `log(text)` prints a line.

### A sample: a card with an open question, as a non-admin

`scripts/scenarios/card-with-question.mjs`:

```js
const QUESTION = 'Which colour should the basket button be?';

export default async ({ instance, open, shoot, snapshot, step, log }) => {
  const developer = (await instance.api('/api/projects/AC/members')).find(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  await instance.setFakeCalls([{ tool: 'ask_human', arguments: { question: QUESTION } }]);
  await instance.say('AC', sessionId, 'CALLS please');
  await instance.waitIdle('AC', sessionId);

  const colleague = await instance.invite({
    project: 'AC',
    email: 'dana@acme.test',
    name: 'Dana Dev',
    access: 'developer',
  });

  await step('open the card', async () => {
    // The account is not the owner: print what it may do in the project (the avatar says only "Te").
    const me = await instance.api('/api/me', { as: colleague });
    log(
      `signed in as ${me.email}: ${JSON.stringify(me.projects.map(({ key, access }) => ({ key, access })))}`,
    );
    const page = await open({ as: colleague, path: '/p/AC/tasks/AC-1' });
    await page.waitForFunction((text) => document.body.innerText.includes(text), QUESTION);
    log(await snapshot(page));
    // The question is in the card's timeline, below the fold: the highlight scrolls it into view.
    await shoot(page, 'card-question', {
      widths: [1512, 390],
      highlight: `text=${QUESTION} >> visible=true`,
    });
  });
};
```

```sh
npm run shots -- scripts/scenarios/card-with-question.mjs
```

### PM-287: card priority

Run `npm run shots -- scripts/scenarios/priority.mjs --timeout 300` on the final PM-287 branch.
The integrator captures and inspects these images; Chromium is not run in the Codex sandbox.
The scenario creates fictional cards in the disposable instance and reads UI wording from `hu.ts`.

| Images                                                                          | What to inspect                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `priority-first-use` (1512, 390)                                                | No priority filter before an open card has a level.                                                            |
| `priority-board` (1512, 800, 390, 375), `priority-board-dark` (1512, 390)       | Four distinct 14px shapes after the key; space for stage progress; readable light/dark tokens.                 |
| `priority-drawer-saved` (1512, 390)                                             | Priority below assignee, saved High value, board mark and timeline change; clearing is exercised afterwards.   |
| `priority-drawer-picker` (1512, 390)                                            | Native priority picker opened in the drawer after the viewport is settled.                                     |
| `priority-large` (1512, 800), `priority-large-dark` (1512)                      | PM-283 uses the same priority property in both large layouts.                                                  |
| `priority-save-failed` (1512, 390)                                              | Simulated PATCH failure: Normal remains stored, the select regains focus, the localized alert appears.         |
| `priority-filter-high`, `priority-filter-unset`, `priority-filter-empty` (1512) | Correct matching, subtitle and empty state; selected filter remains available after its last match is cleared. |
| `priority-phone-sheet`, `priority-phone-chip` (390, 375)                        | Third field, selected level, counter and removable chip.                                                       |
| `priority-closed-details` (1512)                                                | Cancelled card still has editable priority in its details.                                                     |
| `priority-viewer` (1512, 390), `priority-viewer-unset` (1512)                   | Viewer sees the set level as text; no select and no unset row.                                                 |

Check keyboard focus, overflow at 375px, and reduced-motion behavior during visual review.
The automated card tests verify that done/cancelled cards have no board mark; priority filters still
use their stored value. The scenario's deliberate error affects only its disposable instance.
Inspect the two picker images before attaching them: Chromium may omit an operating-system native
popup from a page screenshot. If the options are missing, capture the open native picker manually
at the same widths; keep the real select rather than replacing it with a simulated menu.

### Widths

The four widths are the project's review sizes: 1512 (desktop), 800 (tablet), 390 and 375 (phones).
Ask for fewer with `--widths` or `shoot(..., { widths: [1512] })`: each width is one image to attach.

## Attach the images to the card

The default output folder is the member's session folder, which `attach_file` reads (PM-268):

```
attach_file task_key=PM-123 path=$PROJECTMAN_SESSION_DIR/shots/card-with-question/card-question-1512.png
```

Attach what the reviewer needs (a before and an after, in the widths that matter), not every run.
Look at an image yourself before attaching it (the Read tool shows PNGs).

## The fence

The browser may load only the instance's web address, its server address, `data:` and `blob:`
URLs (and the WebSockets to the first two). Every other request, `file:` and the live instance's
`127.0.0.1:4800` included, is refused and printed as `blocked <url>`. This guards against an
accident (a scenario that opens the wrong address). On a Mac it is **not** a security boundary: the
browser runs without Chromium's own sandbox, and the member's sandbox is what limits it.

## Cleanup

The browser closes first, then the instance stops (server and Vite), and the data folder is removed
(not with `--keep-data`). This happens after a success, after a failed scenario, at the timeout and on
SIGINT/SIGTERM; after a signal the exit code is 1 too (`Stopped by SIGINT.`), not the signal's, and
a second signal during the cleanup changes nothing. If the process is killed with SIGKILL the instance's children still stop (they run
under `scripts/lib/child-guard.mjs`) and Chromium ends when its parent's pipe closes.

## Limits

- **Single-process Chromium.** The browser starts with `--single-process --no-zygote` and without
  Chromium's sandbox, because the macOS Seatbelt sandbox of a member refuses what the normal mode
  needs (`bootstrap_check_in … Permission denied (1100)`; checked with Claude Code 2.1.287). A
  page that crashes the renderer takes the whole browser with it: the run fails with exit code 1
  ("The browser exited"). **A second browser context crashes it too** (SIGTRAP, found by the
  probe on a Mac), so `open` keeps one context and changes the account in it.
- **The data is fake.** The AI members are the fake CLIs, so a chat shows scripted answers; use
  `instance.setFakeCalls` and `say` to make the card look like the case.
- **No live data.** Nothing here shows the owner's real project. Reproduce a case with the demo data.
- **A start costs time** (the server, Vite, the browser): a few seconds to half a minute; the default
  `--timeout` is 240 s. One run per question, with many `shoot` calls, beats many runs.
- **The web font is not loaded.** The fence also refuses Google Fonts (`blocked
https://fonts.googleapis.com/css2?family=Bricolage+Grotesque…` in every run: expected, not an
  error), so the images show the fallback font, not the interface's own. The UI/UX designer should
  judge letter shapes and line breaks with that in mind. Serving the fonts from the instance is a
  separate card and the owner's decision.
- **Chromium only**, headless, no video, no downloads.

## The probe

Before relying on a second account, a popup, the four widths and full-page images in a given
sandbox, run `scripts/scenarios/probe.mjs` there and put its output on the card:

```sh
npm run shots -- scripts/scenarios/probe.mjs
```

It logs in as the owner, as another account and as the owner again, one after the other, then opens
a popup, then takes the four widths and a full-page image.
