# English UI glossary

Status: draft by `designer` on PM-1178 (2026-10-30). The developer of PM-1178 commits it as
`docs/design/glossary.md`; the translation cards (PM-1179–PM-1182, PM-1184, PM-1185) follow it.
A word changes here first, then in `apps/web/src/i18n/en.ts`.

This is the English pair of decision 22 ("one word per thing"): one Hungarian UI word has one
English word, and the same thing is never called two names.

## Rules

- **Team content is never translated** (PM-1168 K4): card titles and descriptions, notes,
  messages, questions, and every name from the project configuration (stages, labels, members,
  roles, duties, `projectman.structure.yaml`). Only the UI's own words change.
- **Sentence case** everywhere: "Create project", never "Create Project". Proper names keep
  their case: projectman (always lower case), Operator, Claude, Codex, Gemini, NanoGPT, GitHub.
- **British spelling**, to match the `en-GB` dates and times: cancelled, colour, behaviour,
  organise, licence (noun). Dates and numbers come from `i18n/format.ts`, never hand-written.
- **Voice:** short, direct, "you". Errors say what happened and what to do:
  "Couldn't save the priority. Try again." Contractions are fine (can't, couldn't, don't).
- **Punctuation:** quotes “ ”, apostrophe ’ is not required (plain ' is fine), ellipsis "…"
  (one character), the `·` separator stays, en dash "–" for ranges.
- **Plural:** every number + noun uses `{count|# card|# cards}`. `{done}/{total}` needs none.
- **No article helper:** `withArticle` returns the bare name in English. Hungarian "a(z) {x}"
  becomes "{x}" or "the {x}". Suffixed fragments ("{time}-kor", "{name} részére") become
  "at {time}", "to {name}"; if a sentence can't be assembled from the Hungarian pieces, split
  the key in both locales.
- **Ordinals:** "{index}. lépés a {total}-ból" → "stage {index} of {total}";
  "{count}. próbálkozás" → "Attempt {count}"; "{version}. megállapodás" → "agreement v{version}".
- **Timeline rows** start with a past-tense verb and no subject ("Added {labels}",
  "Cancelled the card."); system events are passive or nominal ("Labels removed: …").
  `apps/server/src/agent-text/timeline.ts` is the model where it describes the same event.
- **Language names** are always in their own language: "English", "Magyar".

## Board and card

| Hungarian                 | English                          | Note                                                           |
| ------------------------- | -------------------------------- | -------------------------------------------------------------- |
| kártya, feladat           | card                             | The UI never says "task". "Új feladat" → "New card".           |
| alkártya, alfeladat, rész | sub-card                         |                                                                |
| tábla; Folyamat (menu)    | board; Board                     |                                                                |
| oszlop                    | column                           |                                                                |
| lépés                     | stage                            | Configured stage names are not translated.                     |
| lépésfajta                | stage kind                       |                                                                |
| téma                      | theme                            |                                                                |
| térkép                    | map                              |                                                                |
| modul                     | module                           |                                                                |
| címke                     | label                            | Hungarian "tag" is **member**, never "tag".                    |
| előfeltétel               | prerequisite                     | "{count} vár rá" → "{count\|# card waits\|# cards wait} on it" |
| kapcsolat                 | relation                         |                                                                |
| hivatkozás                | link                             |                                                                |
| csatolmány                | attachment                       |                                                                |
| elfogadási pont           | acceptance item                  | lezárva / megerősítve → closed / confirmed                     |
| összetettség, pont        | complexity, points               |                                                                |
| prioritás                 | priority                         |                                                                |
| Kidolgozás                | refinement                       | "Kidolgozásra vár" → "Waiting for refinement"                  |
| indítható; Indulásra vár  | ready to start; Waiting to start |                                                                |
| elvet / lezár / újranyit  | cancel / close / reopen          | "cancelled card"                                               |
| beolvasztás               | merge                            |                                                                |
| ág                        | branch                           |                                                                |
| munkafa                   | worktree                         |                                                                |
| ütközés                   | conflict                         |                                                                |
| ellenőrzés (merge)        | check                            |                                                                |
| teljes teszt              | full test                        |                                                                |
| keret (AI-keret)          | plan                             | "{provider} plan", "AI plan"; keretmutató → plan meter         |
| gyorsítótár               | cache                            |                                                                |

## Timeline, sessions, how we work

| Hungarian                                | English                         | Note                                                                                      |
| ---------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| idővonal                                 | timeline                        |                                                                                           |
| munkamenet                               | session                         |                                                                                           |
| általános beszélgetés                    | general chat                    |                                                                                           |
| megbeszélés                              | meeting                         |                                                                                           |
| Beszélgetés (tab) / Terminál / Részletek | Chat / Terminal / Details       |                                                                                           |
| munkakönyvtár                            | working directory               |                                                                                           |
| szolgáltató                              | provider                        |                                                                                           |
| engedély; mód                            | permission; mode                |                                                                                           |
| leállít                                  | stop                            |                                                                                           |
| szünet, szüneteltet, folytat             | pause, pause, resume            | "The whole instance is paused"                                                            |
| élesítés                                 | release                         |                                                                                           |
| átadás, leadás                           | handoff                         | "hands off the work"; átadó jegyzet → handoff note                                        |
| átvevő; felelős                          | the new assignee; assignee      |                                                                                           |
| gépi összefoglaló                        | automatic summary               |                                                                                           |
| javítási kör; javítási körök határa      | fix round; fix round limit      | extra kör → extra round                                                                   |
| kódátnézés; UI/UX átnézés                | code review; UI/UX review       |                                                                                           |
| visszaküldés                             | send-back                       |                                                                                           |
| Körbe fut                                | Going in circles                | körbeírogatás → back-and-forth                                                            |
| bevonás; bevonva                         | involvement; brought in         | page title "Involvements"                                                                 |
| kapu; jóváhagyás                         | gate; approval                  | "Ember dönt" → "A person decides"                                                         |
| feladatkör                               | duty                            | Template duty names come from the template's `en` locale (Ütemezés → Scheduling).         |
| Mit kap a munkájához                     | What they get to work with      |                                                                                           |
| bevezető, útmutató, csapateszköz         | intro, guide, team tool         |                                                                                           |
| induló üzenet; rendszerprompt            | kick-off message; system prompt |                                                                                           |
| Hogyan dolgozunk                         | How we work                     | "Egy kártya útja" → "A card's path"; Alapszabályok → Ground rules; Jelmagyarázat → Legend |

## Waiting for you, Operator, team, messages

| Hungarian                     | English                         | Note                                                                                        |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| Rád vár (the list, nav, pill) | For you                         | Owner's decision on PM-1178 (2026-10-30). Status of a member or session: "Waiting for you". |
| teendő                        | to-do                           |                                                                                             |
| kérdés; döntés                | question; decision              |                                                                                             |
| tárgytalan                    | moot                            |                                                                                             |
| szűrés (Operátor)             | screening                       |                                                                                             |
| Operátor                      | Operator                        | A proper name: capital O.                                                                   |
| integrátor                    | integrator                      |                                                                                             |
| csapat                        | team                            |                                                                                             |
| tag; AI-tag; ember            | member; AI member; person       | "people" in plural, not "humans"                                                            |
| szerep                        | role                            | Configured role names are not translated.                                                   |
| tulajdonos                    | owner                           |                                                                                             |
| meghívás; meghívott           | invite (noun and verb); invited | "invitation" only in e-mail subjects                                                        |
| felvesz (tagot)               | hire                            |                                                                                             |
| elbocsát; elbocsátva          | retire; retired                 | "Retired: {handle}"                                                                         |
| szabadság                     | on leave                        |                                                                                             |
| üzenet; üzenetváltás          | message; conversation           |                                                                                             |
| Jelölések; jelölés            | Feedback; mark                  | The feedback widget's pins on a page.                                                       |
| visszajelzés                  | feedback                        |                                                                                             |

## Settings, machine, owners

| Hungarian                                                | English                                           | Note                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Beállítások                                              | Settings                                          |                                                                                                     |
| gép                                                      | machine                                           |                                                                                                     |
| motor                                                    | engine                                            | The app file name stays `projectman motor.app` (PM-1168).                                           |
| tulajdonosok                                             | owners                                            |                                                                                                     |
| értesítések                                              | notifications                                     |                                                                                                     |
| fiók                                                     | account                                           |                                                                                                     |
| rendszernyelv; csapat nyelve                             | language (your UI language); team language        | Settings label: "Team language".                                                                    |
| időzóna                                                  | time zone                                         |                                                                                                     |
| integrátorkulcs                                          | integrator key                                    |                                                                                                     |
| lépés gazdája                                            | handler                                           | Settings > Board: "Handlers", "no handler". Not "owner": owner is a person with the `owner` access. |
| Keretek; {percent}% keret                                | Limits; {percent}% of plan                        |                                                                                                     |
| ntfy téma                                                | topic                                             |                                                                                                     |
| Rád vár (list)                                           | For you                                           |                                                                                                     |
| Munkaterület                                             | Workspace                                         |                                                                                                     |
| Operátor jogosítványa                                    | Operator permissions                              |                                                                                                     |
| chopper                                                  | chopper                                           | Stays untranslated.                                                                                 |
| Napló (integrator key); e-mail napló                     | Activity log; Log                                 |                                                                                                     |
| belépő                                                   | access file                                       |                                                                                                     |
| Ütemezés; Élesítés jóváhagyása; Visszajelzés-feldolgozás | Scheduling; Release approval; Feedback processing | Duty names, from the template's `en` locale.                                                        |

## Shell (PM-1178)

| Hungarian                                               | English                                      |
| ------------------------------------------------------- | -------------------------------------------- |
| Belépés / Kijelentkezés                                 | Log in / Log out                             |
| Betöltés… / Újra                                        | Loading… / Try again                         |
| Mégse / Bezárás / Küldés                                | Cancel / Close / Send                        |
| nem kötelező                                            | optional                                     |
| Rendszer                                                | System                                       |
| E-mail cím / Jelszó / Neved                             | Email address / Password / Your name         |
| Belépőkód; Beállítókód                                  | Sign-in code; Setup code                     |
| Kapcsolódás… / Megszakadt a kapcsolat, újrakapcsolódás… | Connecting… / Connection lost, reconnecting… |
| Ez az oldal nem létezik.                                | This page doesn't exist.                     |
| Ugrás a tartalomra                                      | Skip to content                              |
| Nyelv                                                   | Language                                     |

Values of the shell enums:

- **priority:** Urgent, High, Normal, Low; Nincs megadva → Not set.
- **stageKinds:** Queue, Work, Intermediate stage, Release, Done.
- **memberStatus:** No account yet, Idle, Working, Waiting for a person, Online, Offline, Invited,
  Retired, Waiting for you, Paused, Pausing…, Can't work ("Can't work: {reason}").
- **sessionState:** Paused, Pausing…, Starting, Idle, Working, Waiting for permission,
  Waiting for a reply, Stopped, Stopped with an error, "Waiting for you: permission".
- **roles.human:** Owner, Admin, Developer, Client, Viewer.
- **permissionModes** (as in Claude Code): Ask permissions, Accept edits, Plan mode, Auto,
  Bypass permissions.
- **columnColors:** Grey, Blue, Teal, Green, Yellow, Orange, Red, Pink, Purple.
- **providers:** unchanged proper names.

## Inbox, Operator, team, messages (PM-1181)

| Hungarian                                 | English                                                                                                                                                                                                                                 | Note                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| tétel (Rád vár)                           | item                                                                                                                                                                                                                                    | "{count\|# item\|# items} waiting for you"                                           |
| tételfajták                               | Permission, Follow-up, Merge, Decision, Question, Approval, Alert, Release, To-do                                                                                                                                                       | `kindsLower`: the same in lower case                                                 |
| döntőgombok                               | Allow, Always, in this session, Deny, Approve, Reject, Other answer, Seen, Stop the work, Let it run, Needs a sharper plan, Give it to another developer, One more round, Keep waiting, Give it to a free developer, Move on, OK, Merge | Short verb forms, not "I allow". Send answer, Open, Recently decided.                |
| Mostanában döntöttél                      | Recently decided                                                                                                                                                                                                                        |                                                                                      |
| Operátor átadta                           | The Operator handed it to you                                                                                                                                                                                                           | handoff                                                                              |
| Indulás (checklist)                       | Getting started                                                                                                                                                                                                                         |                                                                                      |
| Projektmenedzser; elosztó                 | Project manager; distributor                                                                                                                                                                                                            |                                                                                      |
| Engedélyek: Mód; Ha kérdez, ki dönt       | Mode; Who decides when it asks                                                                                                                                                                                                          | A person / AI decider / Nobody                                                       |
| Kimenő hálózat; be / ki                   | Outbound network; on / off                                                                                                                                                                                                              |                                                                                      |
| homokozó; engedélykérés                   | sandbox; permission request                                                                                                                                                                                                             |                                                                                      |
| Kapcsolattartó                            | Contact                                                                                                                                                                                                                                 |                                                                                      |
| előfizetés                                | subscription                                                                                                                                                                                                                            | "AI at once", "max. {limit} pts"                                                     |
| beugró                                    | stand-in                                                                                                                                                                                                                                |                                                                                      |
| AI-tag felvétele; Felveszem               | Hire an AI member; Hire                                                                                                                                                                                                                 | "Hired: {name}"                                                                      |
| Azonosító; Szakterület; Egyszerre         | Handle; Specialty; At once                                                                                                                                                                                                              | "{count\|# job\|# jobs}"                                                             |
| elbocsátás; átnevezés                     | Retire; Rename                                                                                                                                                                                                                          |                                                                                      |
| Szabadságon; Szabadságra küld; Visszahív  | On leave; Send on leave; Call back                                                                                                                                                                                                      |                                                                                      |
| Betöltött szerepek; Saját utasítások      | Roles held; Own instructions                                                                                                                                                                                                            | tömörítés → compaction                                                               |
| Külső teendőt adhat (MCP)                 | Can give owners to-dos (MCP)                                                                                                                                                                                                            |                                                                                      |
| feladatkör-nevek                          | Prioritisation, Requirements analysis, Card breakdown, Triage, Scheduling, …                                                                                                                                                            | `dutyNames`; the UI never says "task"                                                |
| Üzenetek; Új üzenet; Címzettek            | Messages; New message; To                                                                                                                                                                                                               |                                                                                      |
| Kapcsolódó feladat                        | Related card                                                                                                                                                                                                                            |                                                                                      |
| Olvasatlan; Elolvastam                    | Unread; Mark as read                                                                                                                                                                                                                    |                                                                                      |
| Kézbesítésre vár; Munkamenetbe kézbesítve | Waiting to be delivered; Delivered to the session                                                                                                                                                                                       |                                                                                      |
| E-mailben érkezett                        | Came by email                                                                                                                                                                                                                           |                                                                                      |
| Visszajelzés: jelölés; jelölő             | mark; marked by                                                                                                                                                                                                                         | "Mark on the page ↗"                                                                 |
| Visszajelzés szűrői                       | To-do, Handled, Open, Mine, Closed, All; Site                                                                                                                                                                                           | kinds: Point, Area, Element, Page                                                    |
| Ahogy együtt dolgozunk                    | How we work together                                                                                                                                                                                                                    | megállapodás → agreement ("agreement v{version}"); Tanult elvek → Learned principles |
| bevonás szintjei                          | You’d weigh in on everything; Only on what matters; You’d leave it to us                                                                                                                                                                |                                                                                      |

## Words to avoid

task (say card), tag (say label), user (say person or member, "account" for the login),
human (say person), sprint, ticket, issue (except GitHub issues), workflow (say stage or
board), Title Case headings.
