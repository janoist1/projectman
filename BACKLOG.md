# PM backlog (temporary export)

Temporary export of the open cards of the "PM" project board, which lives only in the owner's local projectman instance. Cloud sessions read it and may update the "Állapot" lines. Back on the local machine the changes go to the board, and this file is removed. Client-specific cards are left out on purpose (public repository).

Export: 2026-09-30, main 6f40e6a. Card texts are in Hungarian, as on the board.

## Fejlesztés

### PM-73: Beállítások: elemenkénti szerkesztés, törlés és + gomb (címkék, folyamat)

_Címkék: Válaszra vár_

**Állapot:** Helyben a Codex elkezdte, de a munkaág frissítésénél megállt (commit nincs). A felhőben tiszta lappal megcsinálható.

A tulajdonos kérése: a Beállításokban ne a teljes rész kapcsoljon szerkesztő módba (a mostani „Szerkesztés” gomb), hanem elemenként lehessen szerkeszteni és törölni, és egy „+” gombbal hozzáadni.

**Címkék** (`LabelsSection`, `LabelsEditor`):

- minden címke sorában „Szerkesztés” és „Törlés” gomb; a szerkesztés helyben nyitja meg az adott címke űrlapját (név, szín, jelentés, szabályok) mentés és mégse gombbal;
- „+” gomb új címkéhez;
- a jelentés nélkül használt címkék „Jelentés megadása” gombja maradjon.

**Folyamat** (`PipelineSection`, `PipelineEditor`):

- ugyanígy az oszlopoknál és a szakaszoknál: elemenként szerkesztés és törlés, „+” gomb új oszlophoz és új szakaszhoz;
- a sorrend (fel/le) maradjon elérhető.

**Közös szabályok:**

- egy mentés egy elem változása, a meglévő `pipeline` PATCH útvonalon;
- a mostani szabályok és hibaüzenetek maradnak (például használt oszlop vagy szakasz nem törölhető, a jóváhagyást csak tulajdonos módosíthatja);
- törlés előtt megerősítés;
- a gombokat az látja, aki most szerkeszthet; a többieknek nincsenek gombok;
- ikonos gombok akadálymentes felirattal (aria-label); magyar szöveg csak a `hu.ts`-ben;
- a többi rész (projekt, csapat, keretek) most maradhat a régi módon.

**Tesztek:** a `SettingsPage.test.tsx` meglévő tesztjeit igazítsd az új felülethez; legyen teszt címke, oszlop és szakasz hozzáadására, szerkesztésére és törlésére. `npm run typecheck`, a webes tesztek és a prettier zöldek.

## Átnézés

### PM-75: AI-fejlesztők szabadon dolgoznak a saját munkapéldányukban; engedély csak kifelé ható lépéshez

**Állapot:** Beolvasztva: 8b9a9ba (a PM-66 és a PM-70 is ennek része). Az alkalmazás átnézője utólag nézi át a helyi táblán.

A tulajdonos a PM-73 alatt: „egy valódi fejlesztő nem így dolgozik, nem kér engedélyt egy normál parancs futtatására”.

**Kérdés nélkül** (a saját munkapéldányban):

- szerkesztés;
- tesztek és build;
- függőségek telepítése;
- commit a feladat ágára;
- a saját ág frissítése a fő ágból.

Az átnéző kérdés nélkül olvashatja a fejlesztő munkapéldányát (ezzel a PM-69 is megoldódik).

**Engedéllyel, érthető kérdéssel:** ami kifelé hat vagy nem visszafordítható:

- feltöltés GitHubra;
- beolvasztás a fő ágba;
- a futó példány;
- a munkapéldányon kívüli fájlok;
- titkok.

**Tiltva:** amíg a GitHub-kérdés nincs eldöntve, a feltöltés.

**Megvalósítás:**

- Claude-tagoknál szerepenként előre engedélyezett és tiltott parancsok (`apps/server/src/domain/session-policy.ts`), az átnézőnél a feladat munkapéldánya további könyvtárként.
- Codexnél a munkapéldány git-adatai írhatók, a hálózat zárva marad: feltölteni így sem tud kérdés nélkül. Ezzel a PM-71 is megoldódik.

- **PM-66** Munkaág a helyi alapról, ha a repó nincs GitHubon — _Kész, a PM-75-tel együtt beolvadt (8b9a9ba)._
- **PM-70** Engedélykérés: az érdemi parancs látsszon, ne a „cd” — _Kész, a PM-75-tel együtt beolvadt (8b9a9ba)._

## Indulhat

### PM-46: Tailscale: X-Forwarded-Proto ellenőrzése a telefonos eléréshez

_Címkék: üzemeltetés_

Tailscale-en át (HTTPS proxy mögött) ellenőrizni, hogy a szerver jól kezeli-e az X-Forwarded-Proto fejlécet: biztonságos sütik, átirányítások.

### PM-50: Beolvasztott munkaágak és worktree-k takarítása

A már beolvasztott `codex`, `codex-2`, `codex-3` és `agent-…` worktree-k és ágaik törlése.

### PM-67: Helyi munkamenet GitHub nélkül: commit az ágon, átnézés az ág alapján

Az AI-utasítások most mindig pusht és PR-t kérnek, az átnéző pedig a PR-okat nézi. GitHub nélküli repónál: a fejlesztő a feladat ágán commitol és szól az átnézőnek; az átnéző az ágat nézi a bázishoz képest; a beolvasztást a tulajdonos végzi. Ezzel kiváltható a próbához a tagok utasításaiba írt ideiglenes szöveg (`apps/server/src/context/work-item.ts`).

### PM-68: Repó nélküli feladat ne fusson a munkaterület gyökerében

Egyrepós projektben a repó nélküli feladat (például az importáltak) a munkaterület gyökerében futna, ami itt a tulajdonos éles könyvtára. Ilyenkor az egyetlen repó munkaága legyen a munkakönyvtár, és a feladat repója utólag is legyen beállítható (a módosítási kérésben most nincs `repo`).

### PM-69: Az átnéző jóváhagyás nélkül olvashassa a feladat munkakönyvtárát

**Állapot:** Nagyrészt megoldva a PM-75-tel: az átnéző megkapja a fejlesztő munkapéldányát `--add-dir`-rel; egy `xargs` miatt még kérdezett.

A próbában az átnéző minden olvasó parancshoz (grep, git log, ls) engedélyt kért, mert a fejlesztő munkakönyvtára kívül esik a sajátján. Az átnéző munkamenete kapja meg a feladat munkakönyvtárát további könyvtárként (Claude Code: `--add-dir`), így az olvasás nem kér engedélyt; az írás továbbra is igen.

### PM-76: Újraindított munkamenet: a rendszer szóljon, hogy folytassa

A PM-73-nál a leállított, majd újraindított Codex-munkamenet folytatáskor nem kapott üzenetet, ezért tétlenül állt a parancssorában, a projektman pedig „nem állt készen” állapotot mutatott. Ha egy feladat munkamenete újraindul (kézi indítás egy meglévő munkamenetre), menjen neki egy rövid folytatási üzenet (a feladat, a szakasz, és hogy folytassa ott, ahol abbahagyta), és a készenlét-érzékelés ismerje fel a folytatott Codex-munkamenet parancssorát.

### PM-77: Codex: commit és ágfrissítés szabály szerint, jóváhagyás nélkül

A PM-75 után kiderült: a Codex saját sandboxa szándékosan csak olvashatóvá teszi a munkapéldány git-adatait, akkor is, ha a projektman írhatónak jelöli, ezért a commit és a saját ág frissítése továbbra is engedélyt kér. Megoldás: a szerver szabálya (commandVerdict) a feladat saját munkapéldányában engedje a jól formált `git add`, `git commit -m …` és `git merge --ff-only <alapág|commit>` kéréseket; `cd` máshová, `-C`, `--git-dir`, push és parancsláncolás nélkül. Minden más továbbra is a tulajdonoshoz megy.

### PM-78: Üzenetek oldal átalakítása: tagok szerint, és jogosultsággal az összes üzenet jobb felülettel

A tulajdonos kérése: az ömlesztett üzenetfolyam nem jó.

- **Alapnézet:** tagok szerint rendezve, mint egy csevegőalkalmazásban. Balra a tagok és beszélgetések listája, jobbra a kiválasztott beszélgetés; telefonon előbb a lista, aztán a beszélgetés.
- **„Minden üzenet” nézet:** bizonyos jogosultsággal (javaslat: tulajdonos és admin) az összesített folyam is látható, nagyjából úgy, mint most, csak jobb felülettel: szűrés tagra és feladatra, áttekinthető sorok, ki kinek írt.
- Olvasatlan jelölés és a „Rád vár” kérdések kiemelése maradjon.

## Ötletek

### PM-44: 2. fázis: csapatrituálék és korlátozott alkalmazkodás

_Címkék: 2. fázis, Válaszra vár_

Terv: `docs/design/phase2.md`. 8 kérdésben dönt a tulajdonos:

1. megbeszélések gyakorisága;
2. ki vezeti a tervezést és a demót;
3. kimaradt megbeszélések pótlása;
4. tehetnek-e észrevételt az AI-tagok;
5. mennyire önálló a „Rendszer” tag;
6. értesítés zárt alkalmazásnál (külső push-szolgáltatás);
7. csendes órák;
8. a nehéz parancsok sora.

A javasolt alapértékek a tervben vannak; az alfeladatok a szállítási sorrendet követik.

- **PM-52** Megbeszélés-jegyzőkönyvek és kézi napi állapot: Közös előzmények, webes hozzászólások, teendővé alakítás.
- **PM-53** Finomítás, tervezés, retró és demó képernyők: Típusonkénti jegyzőkönyv, vezetés feladatkör szerint. Előbb döntés: ki vezeti a tervezést és a demót.
- **PM-54** Megbeszélés-eszközök az AI-tagoknak: Hozzászólások irányítása, folytatható munkamenet tagonként és megbeszélésenként.
- **PM-55** Ütemezett megbeszélések: Ütemezési célok bővítése, ismétlődés-szűrés, halasztott meghívások. Előbb döntés: gyakoriság és a kimaradt alkalmak kezelése.
- **PM-56** PM-beállítóbeszélgetés: A PM javaslatokat tesz a folyamatra és a csapatra: előnézet, tulajdonosi jóváhagyás, egyetlen beállítás-commit.
- **PM-57** Észrevételek és retró-követés: Bizonyítékok, csoportosítás, mérhető teendők. Előbb döntés: gyűjtsenek-e az AI-tagok észrevételt.
- **PM-58** „Rendszer” tag: beállítás-módosítás korlátok között: Szűk műveletkatalógus, a tulajdonos szabta korlátok, ellenőrzött visszaállítás; kiadást nem hagyhat jóvá. Előbb döntés: mennyire önálló.
- **PM-59** Böngészőértesítések, majd telepíthető webapp (PWA): Beállítások, csendes órák, kézbesítési állapot. Előbb döntés: kell-e külső push-szolgáltatás a zárt alkalmazáshoz.
- **PM-60** Nehéz parancsok közös sora: npm install, build és tesztek sorban egy gépen, minden projekt és tag között; sorszám, megszakítás, újraindulás utáni rendbetétel. Előbb döntés: mennyire szigorú.

### PM-45: Szerver: tartósan futó gép Tailscale mögött

_Címkék: üzemeltetés, Válaszra vár_

Kell egy tartósan futó gép (PTY-munkamenetek, worktree-k a lemezen, SQLite, claude-belépés); a Vercel/serverless nem jó, az AWS túlzás.

Irány: Hetzner 8 GB VPS Tailscale mögött. Méretezés: kb. 2 GB alap + 1–1,5 GB egyidejű fejlesztőnként; egy Claude-munkamenet kb. 165 MB. A fejlesztői korlát így a memóriát is korlátozza.

### PM-47: Terméknév és átnevezés

_Címkék: Válaszra vár_

**Állapot:** A tulajdonos döntésére vár; a névjelöltek és az ütközések a helyi táblán vannak.

Terméknév-döntés és a kód átnevezése utána.

### PM-49: Codex: a tulajdonos saját hookjai ellenőrzés nélkül futnak

A Codex-tagok a `--dangerously-bypass-hook-trust` kapcsolóval indulnak, így a tulajdonos saját Codex-hookjai jóváhagyás nélkül futnak. Dokumentálni, vagy elérni, hogy csak a projektman hookjai fussanak.

### PM-51: A projektman fejlesztésének átvitele a projektmanba

Most Claude (a Claude Code-beszélgetésben) és Codex (külön worktree-kben) dolgozik a projektmanon; ez a projekt csak mutatja a feladatokat, az AI-munka főkapcsolója ki van kapcsolva.

Az átvitelhez: a Claude- és a Codex-tag beállításainak ellenőrzése, a főkapcsoló bekapcsolása, egy első próbafeladat.

### PM-71: Codex-commit jóváhagyás nélkül a feladat ágán?

**Állapot:** Részben: a `writable_roots` nem elég, mert a Codex sandboxa a .git-et így is csak olvashatóvá teszi. A folytatás a PM-77.

A Codex-tag minden commithoz engedélyt kér, mert a git metaadatai a munkakönyvtáron kívül, a közös `.git`-ben vannak. Megoldás lehet a `.git` írhatóvá tétele a munkamenetnek, de akkor a sandbox a többi ágat (például a main-t) sem védi. Döntés kell: kényelem vagy védelem.

### PM-72: Az éles példány külön könyvtárból fusson

_Címkék: Válaszra vár_

Az éles projektman most abból a könyvtárból fut (`npm run dev`), ahová a fejlesztés beolvad, így minden szerveroldali beolvasztás újraindítja, és megszakítja a futó AI-munkameneteket; egy AI saját magát is leállítaná. Javaslat: az éles példány külön könyvtárból, buildelve fusson (`npm run build`, `npm start`, lásd `docs/DEPLOY.md`), és csak a tulajdonos által jóváhagyott élesítéskor frissüljön. Ez a feltétele, hogy a projektman valóban saját magát fejlessze.

### PM-74: AI-kérdések közérthetően: egy mondat, javaslat, következmények

A tulajdonos visszajelzése a PM-73 kérdésére: hosszú és túl technikai volt, így nehéz jó döntést hozni.

Javaslat:

- **Az AI-kérdés szerkezete** (a kontextuscsomag `ask_human` szabályai):
  - egy mondatos, köznyelvi kérdéssel kezd;
  - megmondja, mit javasol és miért;
  - minden lehetőségnél a következményt írja le, nem a parancsot;
  - a technikai részletek a végére kerülnek.
- **Felület:**
  - a javasolt lehetőség „Javasolt” jelölést kap;
  - a részletek lenyithatók;
  - a gombok azt mondják, mi történik, nem azt, hogy ki mit csinál.
- **Kevesebb kérdés:** ami rutin és biztonságos (például a saját feladatág frissítése), azt ne kérdezze; ehhez PM-66, PM-69, PM-70.
