# Mac single → EC2 cloud + Mac engine: tulajdonosi runbook (PM-674)

## ARM képcsomag előfeltétel mindkét körhöz (PM-718)

A rögzített cél Frankfurt (`eu-central-1`), `t4g.micro`, Ubuntu 24.04 arm64, 20 GiB gp3.
A gépválasztást nem kérjük újra; az erőforrás-létrehozás és minden átállási kör külön konkrét
tulajdonosi jóváhagyást igényel. Config v1: `aws.ec2.architecture: "arm64"`, valamint
`deployment.imageBundle` (relatív út a config könyvtárához). Az AMI továbbra is ellenőrzött
Canonical Ubuntu-kép, a type/AMI/létező instance architektúrája egyezzen.

Az owner/integráló **külön admin/builder gépen**, tiszta checkoutból, a jóváhagyott teljes SHA-n
futtatja: `npm run cloud -- image-build --ref <SHA40> --out <ÚJ_REPÓN_KÍVÜLI_KÖNYVTÁR>`.
Előtte ugyanennek a `--dry-run` változata használható. Alapból csak a cél gép platformja épül
(`linux/arm64`, PM-916); mindkettő csak `--all-platforms` kapcsolóval. Előre rendelkezésre álló
Docker/Buildx docker-container driver és a kért platformhoz natív builder/emuláció szükséges. A parancs nem
fetch-el, nem vált ágat, nem hoz létre infrastruktúrát és nem publikál registrybe.

A konkrét kör jóváhagyásába kerüljön a bundle `sourceSha` értéke, a kiválasztott
`linux/arm64` platform, `archiveSha256`, `archiveBytes` és `imageId`; a Mac motor target SHA-ja
egyezzen. A manifest integritási metaadat, eredetét az ellenőrzött builder és a konkrét csomag
jóváhagyása biztosítja. Mindkét platform valódi buildjével és izolált futtatásával bizonyítandó:
Node/better-sqlite3 betöltés, cloudflared/litestream/restic indulás, cloud szerver smoke eldobható
adattal; külön figyelni kell az 1 GiB RAM-ra és import közbeni lemezhelyre.

Átállás előtt `deploy --ref <SHA40> --dry-run` ellenőrizze a bundle-t. Seed sorrendje:
üres bucket/stopped-empty guard → adatfeltöltés → PM-717 seed-integrity → ellenőrzött image
import → receive-env → immutable ID-val indítás → SHA/ID/platform health. ARM-on nincs host
build és nincs fallback. Hibás kép esetén nincs új start; seed-integrity hibánál nincs import
sem. A public kapcsolás marad edge → deploy → check. A rollback az előző rögzített digestet
viszi tovább, ARM-on digest nélküli régi rekord megtagadás. Ez nem DB-visszamigrálás: a meglévő
recovery-kapu és figyelmeztetés megmarad. A két kör közötti célürítés PM-719 feladata.

Ez a PM-675 végrehajtási lapja; **önmagában nem engedély éles műveletre**.
A PM-674 csak dokumentációt és eldobható, fake-alapú ellenőrzést készít.
AWS/Cloudflare/SES műveletet, védett adatolvasást és szolgáltatáskapcsolást az owner vagy
az integráló végez a saját adminisztrációs gépén, a konkrét lépés jóváhagyása után.
AI tagi sandboxnak nem adunk credentials-kivételt.

## Az owner rövid lépéssora

1. Kitöltött céladatok, költség-preview, elfogadott teljes commit SHA és eldobható
   átállási/visszaállási próba eredménye legyen a PM-675 kártyán.
2. Külön hagyd jóvá az AWS-erőforrásokat, SES/DKIM beállítást és production kérelmet.
   A DNS már Cloudflare: nincs új delegációváltás; a meglévő mail rekordok maradnak.
3. Hagyd jóvá a konkrét élő leállítási ablakot és privát átállást. Az adatátvitel
   engedélye már megvan; ezt nem kell újra kérni.
4. Pause → Mac single és watcher stop → stopped-source package/verify → üres cloud
   seed → Mac engine ugyanazzal a SHA-val → privát ellenőrzés.
5. A kész belépési és public edge változat független security eredménye után az
   integrátor végzi a kapcsolást a PM-675 aktuális tulajdonosi iránya szerint.
   A PM-703/713-at tartalmazó verzión a nyilvános megnyitásra nem kérünk újabb igent.
   Backup, izolált restore,
   Mac-off/on, valódi meghívott ügyfél és owner elfogadás zárja az átállást.
6. Hibánál először edge-zár, majd cloud pause/stop és végleges adatletöltés;
   csak ennek visszahozása után indulhat újra a Mac single és watcher.

## Kitöltendő végrehajtási lap

A `<...>` mezők helyére konkrét érték kell; a parancsblokkok nem egyben futtatandó szkriptek.
Minden lépésnél ellenőrizd az eredményt. Nem nulla kilépésnél STOP; nincs automatikus
törlés, retry, új példány vagy seed-felülírás. Cloud CLI: 0 siker, 1 hiba, 2 megtagadás,
64 hibás használat. A migrate/engine saját kilépési kódját és szövegét is rögzítsd.

| Mező                                    | Kitöltendő / ellenőrzendő                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<APPROVED_SHA>`                        | Elfogadott, távolról elérhető teljes 40 hex SHA; tartalmazza PM-666–672, PM-676–678 szükséges változásait. A runbook commitja nem automatikusan a kiadási SHA.                            |
| `<ENGINE_CHECKOUT>`, `<ADMIN_CHECKOUT>` | Saját, tiszta checkoutok; az engine HEAD és a cloud build pontosan `<APPROVED_SHA>`. A shared fejlesztői checkoutot ne váltsd át.                                                         |
| `<SOURCE_HOME>`, `<LIVE_ROOT>`          | Owner által ellenőrzött védett forrás, jelenleg `~/.projectman`, illetve `~/projectman-live`; nincs live adatolvasás a kártya fejlesztésekor.                                             |
| `<PACKAGE>`, `<RETURN_DATA>`            | Új könyvtárak a védett `~/.config/projectman/cloud/` alatt, a forráson és minden git repón kívül. Package mód 0700, fájlok 0600; letöltés új, nem létező könyvtárba.                      |
| `<CONFIG>`, `<PRIVATE_CONFIG>`          | Védett cloud JSON, és előre megőrzött privát konfiguráció. Azonos EC2/bucket/tunnel/hostname adatok; csak az elfogadott public/private mód térhet el.                                     |
| AWS accountok                           | `aws.compute=ec2`, `aws.profile=aroom`, `route53.profile=i`; mindkét STS account ID és owner által választott compute régió.                                                              |
| EC2                                     | Frankfurt, `t4g.micro`, `architecture=arm64`, Canonical Ubuntu 24.04 arm64 `amiId`, meglévő `vpcId`, public `subnetId`, 20 GiB gp3, instanceName; preflight/dry-run igazolja.             |
| Backup                                  | Két külön, egyedi private S3 bucket: `databaseBucket`, `backupBucket`; kezdetben üresek. `RESTIC_PASSWORD` külön password managerben, nem csak cloud.env-ben.                             |
| SES                                     | Explicit `ses.region`, `ses.domain=istvan.io`, ownerrel választott `ses.from`; identity és küldési IAM **aroom**, nem a regisztrátor `i` fiókja.                                          |
| Cloudflare                              | Meglévő aktív istvan.io zone/account ID, chopper.istvan.io, választott widget hostname, tunnel, owner Access-email lista, engine Service Auth token.                                      |
| Költség                                 | Választott régió aktuális EC2 running-hour, gp3 EBS, public IPv4, S3/forgalom és SES küldési díjai, becslés dátuma; aws/SES dry-run komponenseivel együtt. Nincs implicit költségdefault. |
| Elfogadás                               | Meghívott próbaügyfél, saját megosztott projekt/kártya/fájl, belső és másprojekt negatív próba; owner és security eredmény; leállítási ablak, felelős, rollback-határidő.                 |

Titok nem kerül a lapba, kártyába, üzenetbe vagy argv-ba: csak a védett tárolási helye.
Az admin gépen AWS CLI v2, session-manager-plugin, OpenSSH és megfelelő MFA-login kell.
Az EC2 inbound security group üres; SSH csak SSM `AWS-StartSSHSession` csatornán,
ideiglenes EIC kulccsal és ellenőrzött hostkulccsal megy. Nincs public SSH fallback.
Cloud env/adat csak titkosított stdin/stream: nem UserData vagy SSM command log.

## 0. Eldobható bizonyítás, az élő engedély előtt

A repó gyökeréből az alábbi célzott tesztek kizárólag temp home-ot, fixture-adatokat,
fake agenteket és fake AWS/Cloudflare/hostot használnak:

```sh
cd apps/server
npx vitest run --configLoader runner test/hybrid-migration.test.ts test/cloud-machine.test.ts test/cloud-engine.test.ts test/deploy-cloud.test.ts
```

A migration fixture stopped-source csomagot készít, cloud utáni változásokat hoz vissza,
üzenetfájl-hash-t és archiválást ellenőriz, majd activate-ot próbál; megtagadja a futó
engine-t/telepített LaunchAgentet és a régi DB aktiválását. A cloud-machine fixture
üres cél/bucket seedet, futó/már használt cél elutasítását, végleges pull-data-t és
pinelt SHA-t vizsgál. A cloud-engine próba offline várakozást/online egyszeri indulást
és a valódi összeállítás határát fake CLI-kkel ellenőrzi. A deploy-cloud fixture
backup/restore fájllefedettséget és standby izolációt bizonyít. Ezek nem EC2/S3/Docker
élő bizonyítékok. Port/PTY sandbox-megtagadást a kártyán rögzítsd; nincs kerülőút.

Az owner az élő leállítás előtt egy **eldobható**, saját fixture-adatokból készült
home-on ismételje meg a 2–3. és rollback lépést, fake CLI vagy külön tesztlogin mellett,
külön cél/bucketeken. Ne klónozza a futó live DB-t, és ne használjon production backup
bucketet. Rögzítse package verify, fájlhash, DB logikai darabszám, engine-binding,
cloud utáni új adat visszahozása és egyetlen writer eredményét. A próba sikertelen:
STOP az élő változat jóváhagyása előtt.

## 1. Preflight, AWS, SES, privát edge

Csak owner/admin gépen, kitöltött konfigurációval. [AWS.md](AWS.md) tartalmazza a
szükséges jogokat és a részleges hibák kezelését.

```sh
aws --profile aroom --region <COMPUTE_REGION> sts get-caller-identity
aws --profile i --region us-east-1 sts get-caller-identity
npm run cloud -- preflight --config <CONFIG>
npm run cloud -- aws --dry-run --config <CONFIG>
```

Check: accountok, konkrét instanceType/AMI/VPC/subnet/EBS, költségkomponensek.
Owner `ask_human` jóváhagyás az erőforrások és költség pontos preview-jára, majd:

```sh
npm run cloud -- aws --config <CONFIG>
npm run cloud -- ses plan --config <CONFIG>
npm run cloud -- ses configure --dry-run --config <CONFIG>
```

Külön jóváhagyott SES/DKIM/IAM művelet, majd:

```sh
npm run cloud -- ses configure --config <CONFIG>
npm run cloud -- ses request-production --dry-run --config <CONFIG>
```

Külön jóváhagyott production kérelem, majd:

```sh
npm run cloud -- ses request-production --config <CONFIG>
npm run cloud -- ses check --config <CONFIG>
npm run cloud -- edge --dry-run --config <PRIVATE_CONFIG>
```

Check: SES ugyanabban a választott régióban verified identity, DKIM SUCCESS,
production és sending enabled; a kérelem elküldése még nem AWS-jóváhagyás.
IAM csak `ses:SendEmail`, identity ARN és pontos FromAddress; a három DKIM CNAME
DNS-only. A meglévő MX/SPF/DMARC/TXT rekordokat és delegációt ne módosítsd.
Nincs `dns switch`, `dns import` vagy `up` ebben az átállásban.

Külön jóváhagyott privát edge művelet:

```sh
npm run cloud -- edge --config <PRIVATE_CONFIG>
```

Check: board privát Access Allow (integrátor csak külön saját token, ha szükséges),
`/engine` kizárólag saját Service Auth, widget csak `/feedback/` + 404, hooks/mcp 404,
origin loopback és eredeti Host. A védett `engine-access-token.json` később a Macen
marad. Restic jelszó külön mentése kötelező. Még nincs üres `deploy` vagy publish:
a seed előtt indított üres board adatot/bucketet foglalhatna el.

## 2. Jóváhagyott élő ablak: pause, stop, package, seed

PM-675 `ask_human`: konkrét SHA, source/cél/bucket, ablak, leállítás és privát seed/engine
változtatás, ellenőrzések és rollback. A DB/csatolmány adatátviteli engedélyt ne kérd újra.
Az elfogadott ablak előtt az alábbi parancsok nem futnak.

```sh
npm run control -- pause --wait --reason 'cloud cutover' --home <SOURCE_HOME>
npm run control -- status --home <SOURCE_HOME>
npm run live -- uninstall --home <SOURCE_HOME>
npm run migrate -- hybrid plan --home <SOURCE_HOME>
npm run migrate -- hybrid package --home <SOURCE_HOME> --out <PACKAGE> --engine-name Mac --cloud https://chopper.istvan.io
npm run migrate -- verify --home <PACKAGE>/home --hybrid-cloud
npm run cloud -- seed --from <PACKAGE>/home --ref <APPROVED_SHA> --dry-run --config <PRIVATE_CONFIG>
```

Check: pause befejeződött, **mindkét** live LaunchAgent eltávolítva, nincs Mac single
process vagy folyamatban lévő release journal. Az uninstall megtagadja az aktív release-t:
STOP, ne bootouttal kerüld meg. A package futó forrást és létező engine key/configot
megtagad; ne töröld ezeket retry célból. Verify: egy ismert nem visszavont default engine.
Csomaggyökerek: db.sqlite, secret, secrets, customization, attachments,
message-attachments, feedback, memory; provider/repo/engine.key nem megy a cloudba.
Forrás→package DB hash változhat engine-binding miatt; logikai számlálás és az ismert
binding-változás szükséges, nem byte-egyezés a régi forrással.

A seed dry-run a két bucket ürességét és a helyi DB előfeltételeit olvassa, jelzi a kötelező
integritáskaput; **nem kapcsolódik a hosthoz**, és nem állít sikeres távoli hash-ellenőrzést.
A host stopped/empty ellenőrzése a valódi seedben, az upload előtt történik:

```sh
npm run cloud -- seed --from <PACKAGE>/home --ref <APPROVED_SHA> --config <PRIVATE_CONFIG>
npm run cloud -- status --config <PRIVATE_CONFIG>
```

Check: seed-check stopped/dataEmpty=true, mindkét bucket üres, upload után pontos SHA
és health siker. Host cél `/var/lib/projectman/data`, container `/data`; source kizárólag
`<PACKAGE>/home`, nem a manifestet is tartalmazó package gyökér. A CLI seed egyben deployol
és indít, de csak a PM-717 kötelező kapuja után: a feltöltés előtti és utáni forrás DB-hash/méret
és a stopped host `seed-digest` válasza pontosan egyezzen. Mindkét oldalon normál, nem symlink
DB kell, WAL/SHM/journal nélkül. A csomag az egész művelet alatt lezárt bemenet; az ablaknak
egyetlen végrehajtója van, más cloud művelet nem indíthat közben boardot.
Rögzítsd PM-675-ön a build/start ELŐTT megjelenő bizonyítékot:
`ok seed-integrity: database sha256=<64hex> bytes=<n> (before first start)`.
Fájltartalmat ne rögzíts. Futó DB már írhat és migrálhat; a forrás→package logikai DB-számlálás
és a többi fájlgyökér tartalmi hash-ellenőrzése továbbra is PM-675 külön elfogadási lépése.
`FAIL seed-integrity`: **STOP**, nincs build/start vagy automatikus retry/deploy; a feltöltött adat
megmarad, nincs törlés/felülírás, új seed a használt célt megtagadja. Kérj tulajdonosi recovery döntést.
Helyi előfeltétel és host-állapot megtagadása CLI exit 2 (host exit 3); eltérés, forrásváltozás,
hibás/hiányos JSON, olvasási/számítási vagy transporthiba CLI exit 1.
Használt cél/bucket vagy bármely hiba: STOP, owner kérdés új célról vagy recovery útról;
nincs önkényes törlés/ürítés. A régi Mac DB-t eközben soha ne indítsd vissza.

## 3. Mac engine, privát ellenőrzés

Az owner a saját engine checkoutját állítsa az elfogadott SHA-ra; `git rev-parse HEAD`
eredménye egyezzen a cloud status SHA-val. Ne a közös fejlesztői checkoutot váltsa át.
Telepítse a lockfile szerinti függőségeket, a CLI előfizetéses loginok maradnak a Macen.

Új, saját checkout készítése az owner adminisztrációs környezetében (a cél még nem létezik):

```sh
git clone --no-checkout <APPROVED_REPOSITORY_URL> <ENGINE_CHECKOUT>
git -C <ENGINE_CHECKOUT> checkout --detach <APPROVED_SHA>
cd <ENGINE_CHECKOUT>
npm ci
git rev-parse HEAD
```

Ezt az előkészítést az ablak előtt is el lehet végezni; szolgáltatást csak a jóváhagyott
átállásban indíts. Meglévő saját engine checkout frissítésekor előbb uninstall és tiszta
git status kell, majd az owner fetch/checkout művelete ugyanarra az elfogadott SHA-ra.

```sh
npm run migrate -- instance engine --home <SOURCE_HOME> --reason 'cloud cutover'
npm run migrate -- instance status --home <SOURCE_HOME>
```

Az owner védett szerkesztővel tegye az `engine.json` `linkHeadersFile` mezőjébe az
**abszolút** `~/.config/projectman/cloud/engine-access-token.json` útvonalat (a tényleges
home-mal kibontva). A fájl mode 0600, a szülő 0700, nem kerül repóba. Nincs új init:
a package már elkészítette engine.json/key-t; init felülírás új engine-t hozna létre.
Az engine státusz a foreground indulás előtt még offline lehet.

Az `<ENGINE_CHECKOUT>` könyvtárból:

```sh
git rev-parse HEAD
npm run engine -- status --home <SOURCE_HOME>
npm run engine -- start --home <SOURCE_HOME>
```

Check: engine online, ugyanaz a SHA, helyes workspace/repo/full-test utak, kifelé kapcsolódó
link, nincs single writer. Foregroundot Ctrl-C-vel állítsd le, és várd meg a kilépést, majd:

```sh
npm run engine -- service install --home <SOURCE_HOME>
npm run engine -- service status --home <SOURCE_HOME>
```

Check: launchd a helyes checkoutot és előfizetéses CLI-ket megtaláló PATH-ot használja.
A cloudban az átvitt ownerrel lépj be, nem új setupot hozz létre. A hostname első privát
DNS-publikálása is jóváhagyott változtatás; már használt/ütköző rekordnál STOP.

```sh
npm run cloud -- publish --dry-run --config <PRIVATE_CONFIG>
```

Owner jóváhagyás után:

```sh
npm run cloud -- publish --config <PRIVATE_CONFIG>
npm run cloud -- check --login-json <PROTECTED_LOGIN_JSON> --config <PRIVATE_CONFIG>
```

Check: Access + alkalmazáslogin, owner tábla/kártya/inbox, minden fájltípus, engine RPC/MCP,
repo/teszt és egy próbamunka. A kézi pause átkerül a cloud DB-be: csak az owner ellenőrzése
után resume a cloud UI-n. Offline feladatról bizonyíts tartós várakozást, majd egyszeri
indulást. A login JSON mód 0600; jelszót/tokent ne csatolj, csak az eredményt.

## 4. Saját webes belépés és nyilvános kapcsolás

A PM-670/671/672 saját belépése és `access.boardMode` kapcsolója már megvalósult.
A PM-675 2026-10-19-i tulajdonosi iránya szerint az emberek számára a webes belépés
az egyetlen belépés: a főoldal előtt nincs külön Cloudflare Access-forduló. A gépi
hozzáférés védelmét a PM-675 végleges műszaki terve szerint kell megtartani.

Az elfogadott SHA tartalmazza a belépési keményítéseket is: PM-703 (kódbeváltási
időzítés és IPv6-korlát), PM-713 (biztonságos visszairányítás), valamint a PM-675
végleges változtatását. A kártyák beolvasztása önmagában nem igazolja a telepített
verziót: a cloud image forrás-SHA-ját és az engine SHA-ját külön rögzíteni kell.
A login/public határ végleges változata független security-átnézést igényel.

`<CONFIG>` `access.boardMode=public`, `<PRIVATE_CONFIG>` private. A PM-675 aktuális
tulajdonosi iránya alapján a nyilvános megnyitásra nem kell külön ismételt igen,
ha a futó kép tartalmazza a PM-703 és a PM-713 javításait. A kiadás a PM-735 útján
megy; a konkrét SHA, képazonosító, hostname/widget, végrehajtó és rollback a
végrehajtási csomagban legyen rögzítve. Az integrátor az élő kapcsolás előtt végzi
a végleges CLI read-only preview-ját:

```sh
npm run cloud -- edge --dry-run --config <CONFIG>
npm run cloud -- deploy --ref <APPROVED_SHA> --dry-run --config <CONFIG>
npm run cloud -- publish --feedback --dry-run --config <CONFIG>
```

A végleges megvalósítás és a képcsomag ellenőrzése után az integrátor egy menetben futtatja:

```sh
npm run cloud -- edge --config <CONFIG>
npm run cloud -- deploy --ref <APPROVED_SHA> --config <CONFIG>
npm run cloud -- check --login-json <PROTECTED_LOGIN_JSON> --config <CONFIG>
npm run cloud -- publish --feedback --config <CONFIG>
```

Az `edge → deploy → check` összefüggő műveletsor: a fő hostname már publikált lehet,
ezért edge és check között nincs megállás. A `publish --feedback` csak sikeres deploy/check után,
a publish meglévő public-check kapuján át futhat. Bármely hibánál azonnal private edge-zár
(6. szakasz), javítás közben nem maradhat nyitva. Ez a leírás nem ad élő végrehajtási engedélyt.

Check: public=true, emailLoginEnabled=true, needsSetup=false; anonim auth/me 401,
idegen Origin 403; fő Access Bypass/Everyone, **engine továbbra is csak Service Auth**,
engine ingress audience-ellenőrzéssel, fő ingress saját loginhoz audience-zár nélkül.
Widget csak saját útvonalai, hooks és a tagi `/mcp/<token>` 404, anonim WS/API elutasítás.
A bare `/mcp` az integrátor külön bearer-végpontja (PM-760); annak és az integrátori
API-nak a védelmét a PM-675 végleges terve szerinti külön próbával ellenőrizd.
Valódi meghívott
ügyfél OTP-belépés siker; belső/másprojekt adat és owner/terminál művelet tiltott.
Hibánál azonnal az 6. szakasz edge-zárja, ne hagyd public állapotban javítás közben.

### Titokmentes elfogadási jegyzőkönyv (PM-675)

Az integrátor a deploy után a kártyára írja minden próba nevét, időpontját,
végrehajtóját, elvárt és tényleges eredményét, valamint PASS/FAIL állapotát.
E-mail-címet, kódot, kulcsot, cookie-t vagy nyers választ nem csatol.
Az automatizált teszt eredménye és az élő próba eredménye külön bizonyíték.

| Próba                | Elvárt élő eredmény                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human-entry`        | Kijelentkezett böngészőben a saját webes belépés elérhető Access-átirányítás nélkül; anonim API/WS továbbra is 401.                                                                                         |
| `owner-login`        | A tulajdonos belép, a tábla és a Rád vár látható.                                                                                                                                                           |
| `client-email-login` | A tulajdonos próba-aliasára küldött meghívóval és valódi SES-kódlevéllel sikeres az ügyfélbelépés.                                                                                                          |
| `client-visibility`  | Megosztott kártya és csatolmány olvasható; nem megosztott/belső, másprojektbeli és nem létező kártya vagy fájl, terminál és tulajdonosi művelet elutasítva. Az egyes tiltási próbák külön eredményt kapnak. |
| `machine-engine`     | A `/engine` Access- és gépkulcsvédelme működik; az engine Service Auth token nem ad webes belépést.                                                                                                         |
| `machine-integrator` | Az integrátor/super elérés megfelel a végleges gépi határtervnek; anonim és nem megfelelő hitelesítővel nem érhető el.                                                                                      |
| `widget`             | A külön feedback hoston beküldött jelölés megjelenik a táblán; azon a hoston csak a widget útvonalai élnek.                                                                                                 |
| `mac-off-on`         | Mac nélkül a belépés/tábla/Rád vár/widget működik, az AI-indítás és üzenet vár; az engine visszatérésekor egyszer indul vagy folytatódik.                                                                   |

Az elfogadást az első FAIL-nél meg kell állítani a kártya rollback-szabálya szerint.
A többi elfogadási feltétel (adatmegőrzés, egyetlen író, felhő-újraindítás,
mentés/visszaállítás és restic-jelszó) bizonyítékai is szükségesek a PM-675 lezárásához.

## 5. Első backup, restore és elfogadás

Az első fájlbackup alapból indulás után 300 s, utána 21600 s. Az első **sikeres teljes**
snapshotig nincs fájlvédelem: várd meg, a cloud logsban ellenőrizd a sikerét/snapshot idejét.
Hibánál STOP az elfogadással. Ne indíts párhuzamos restic backupot a loop mellé.

```sh
npm run cloud -- logs --lines 200 --config <CONFIG>
npm run cloud -- rehearse --config <CONFIG>
```

A rehearsal külön scratch container: standby, loopback, nincs tunnel, replication vagy
AI session. `REHEARSAL PASSED` csak restore/HTTP smoke. Az [izolált fájl- és DB-reference
ellenőrzés](HYBRID.md#backup-and-restore) is kell: minden ready card/message/widget fájl
létezik, méret helyes, rögzített forrásinventoryval SHA-256 egyezik; secret/customization/
memory is ellenőrzött. A produkciós attachment táblák nem tartalmaznak content hash-t.
Rehearsal után külön megtartott izolált helyreállításban végezd az inventory-ellenőrzést
a HYBRID.md szerint; a CLI átmeneti smoke-könyvtára önmagában nem tartós bizonyíték.

A már jóváhagyott rehearsal részeként `npm run cloud -- ssh --config <CONFIG>` után,
az EC2 shellben, új és üres `<RESTORE_STAMP>` könyvtárral:

```sh
sudo mkdir -m 700 /var/lib/projectman/restore-<RESTORE_STAMP>
sudo chown 10001:10001 /var/lib/projectman/restore-<RESTORE_STAMP>
sudo docker run --rm --env-file /etc/projectman/cloud.env -e REHEARSAL_DIR=/restore -e REHEARSAL_PORT=4701 -v /var/lib/projectman/restore-<RESTORE_STAMP>:/restore projectman-cloud:<APPROVED_SHA> rehearse
```

Check: a mount nem `/var/lib/projectman/data`, a kép a futó cloud SHA-ja, a könyvtár üres,
tulajdonosa `10001:10001`, módja `0700`. Az entrypoint a `/data` tulajdonosát állítja be,
a külön `/restore` mountét nem; ezért a fenti chown kell az unprivileged rehearsal írásához.
A restore fájljai a container kilépése után megmaradnak; az owner ezen a védett másolaton
végezze a hash/reference vizsgálatot. Ne indítsa `serve` módban vagy production volume-on.

Rögzítsd a restic snapshot és Litestream DB pont idejét: nincs közös atomikus snapshot,
a fájlkiesés **legfeljebb 6 óra + backup hibaidő** a normál ütemben; az 1 s DB sync nem
garantált RPO. Hiányzó fájl esetén verified másolat vagy korábbi DB pont és új izolált
ellenőrzés kell. Ne fogadj el hiányzó referenciát sikeres server start alapján.

Ownerrel egyeztetett Mac-off/on próba: Mac kikapcsolva board/login/inbox/widget működik,
AI munka tartósan vár; visszatérő engine egyszer folytat/indít. Cloud restartnál a mai
szerződés lezárja a távoli élő sessiont, új start/resume kell, mutáló RPC-t ne ismételj vakon.
Végül valódi ügyfél és owner elfogadás a PM-675-ön, időpontokkal és veszteségkimutatással.

## 6. Stop és visszaállás: egyetlen writer

Az owner előre elfogadott rollback-útja és konkrét határideje szerint; ezen túl új
`ask_human` kell. Ne indítsd a stale Mac DB-t cloud utáni írások helyett.

1. **Azonnali edge-zár**: a kész PM-672 CLI-jével privát konfigurációra váltás:

   ```sh
   npm run cloud -- edge --config <PRIVATE_CONFIG>
   ```

   Ellenőrizd külső anonim böngészővel az Access redirect/403-at. Ha a CLI/API elérhetetlen,
   az owner admin Cloudflare felületén zárja a board appot privát Allow-ra; engine Service
   Auth marad. A widget önálló nyilvános kapu: incidensnél az owner zárja a widget
   hostname ingressét is, más DNS/mail rekordot ne töröljön. Sikertelen edge-zárnál a
   cloud stop azonnal szükséges, ne várj a UI pause-ra.

2. Cloud UI instance pause, várd meg paused állapotot; majd végleges stop/pull:

   ```sh
   npm run cloud -- stop --config <PRIVATE_CONFIG>
   npm run cloud -- status --config <PRIVATE_CONFIG>
   npm run cloud -- pull-data --to <RETURN_DATA> --config <PRIVATE_CONFIG>
   ```

   Check: container stopped, a letöltés teljes és új védett könyvtárba ment. Cloud nem
   indul többé ezen a replica/bucket páron a Mac single mellett. Elérhetetlen végleges
   data esetén STOP: snapshot recovery és pontos veszteség owner-döntése kell.

3. A Macen foreground engine stop, és a KeepAlive LaunchAgent eltávolítása:

   ```sh
   npm run engine -- service uninstall --home <SOURCE_HOME>
   npm run migrate -- hybrid back --home <SOURCE_HOME> --from <RETURN_DATA> --confirm-source-retired
   npm run migrate -- instance activate --home <SOURCE_HOME> --confirm-source-retired
   npm run migrate -- instance status --home <SOURCE_HOME>
   ```

   Check: cloud adatok/csatolmányok/logikai számlálás megmaradtak, engine revoked,
   régi Mac bejegyzések `pre-hybrid/<date>/` alatt. A confirm flag valódi leállítást
   állít; nem feloldó varázsszó. Nincs `--discard-cloud-data`, nincs régi DB visszamásolás.

4. Csak most indíts single-t és watchert az owner által jóváhagyott, **az átvett DB
   sémáját támogató** Mac buildből, annak checkoutjából:

   ```sh
   npm run live -- install --root <LIVE_ROOT> --home <SOURCE_HOME> --port 4800 --remote <APPROVED_REPOSITORY_URL>
   npm run live -- status --home <SOURCE_HOME>
   ```

   Az install mindkét agentet elindítja és resume-ot végez; ezért csak activate és a
   rollback-adatellenőrzés után fusson. A régi image vagy `cloud rollback` önmagában nem
   fordít vissza sémamigrációt. Ha régebbi build kell, az [AWS point-in-time recovery](AWS.md#restoring-the-database-to-a-point-in-time)
   útját előbb izolált másolaton igazold, és nevezd meg az elvesző DB/fájl időszakot,
   kártyákat/üzeneteket/uploads-ot az owner jóváhagyásában.

5. **Két próbakör között (PM-719):** a végleges downloaded copy maradjon meg védett,
   0700 könyvtárban, repón és a live forráson kívül. A sikeres cloud stop/végleges pull-data,
   hybrid back, activate és Mac single/watcher működésellenőrzés jegyzetének event ID-jával
   készíts resettervet az [AWS runbook](AWS.md#reset-between-the-two-pm-675-trial-rounds-pm-719) szerint.
   Az owner eldöntötte: **„Ugyanaz a gép, kiürítve”**; ezt nem kérdezzük újra. A konkrét tervfájl
   SHA-256-a és a cél/account/bucketek viszont külön végrehajtási jóváhagyást igényelnek.
   Előbb dry-run, csak a pontos jóváhagyás után apply. Nincs élő resetengedély a fejlesztési kártyából.
   Csak hostarchiválás, majd a két próba-bucket leltározott objektumainak feltételes törlése történik;
   nincs gép/bucket/EBS/IAM/DNS/credential törlés, seed vagy start. Bármely eltérés vagy részleges
   hiba STOP és külön jóváhagyott helyreállítás; a régi terv nem futtatható újra.
   A kártyára csak hash/szám/méret és védett tárolási hely kerülhet, objektum-/fájllista nem.
   A hostarchívum és a végleges letöltés legalább a 2. kör teljes backup/izolált restore elfogadásáig
   megmarad; későbbi törlésük külön döntés. A 2. kör új package/verify/seed-integrity-vel indul
   a Mac **akkori megállított állapotából**, PM-718 kész ARM képpel.

6. A fenti megőrzési időszakon kívül package és downloaded copy eltávolítása vagy offline titkosított archiválása az owner
   által. Új AI session előtt ne maradjon titkos csomag szabadon olvasható könyvtárban.
   A régi `pre-hybrid` archívumot csak ellenőrzött single működés után takarítsa az owner.
   EC2/EBS/IPv4/bucket/IAM erőforrások nem törlődnek a rollbacktől; költségük és későbbi
   megszüntetésük külön jóváhagyott művelet. DNS-delegáció visszaváltás nincs.

## Későbbi verziófrissítés és távoli motor

Működik távoli motoron: az AWS/SES/Cloudflare CLI az owner admin gépén, a board/DB/backup
EC2-n fut; a Mac repói, előfizetéses CLI-k és launchd engine szolgáltatás külön maradnak.
Csak migrationcsomag, engine link/RPC/fájlforgalom lépi át a határt, AWS/SES titok nem.

`com.projectman.live-watcher` ma **single Macet** frissít; hybridben eltávolítva marad.
Nincs automatikus cloud/engine watcher. Új ownerrel elfogadott SHA/ablakban: cloud UI pause,
engine service uninstall, cloud `deploy --ref <APPROVED_SHA> --dry-run`, jóváhagyott
`deploy --ref <APPROVED_SHA>`, engine saját checkoutjának ugyanarra a SHA-ra frissítése,
függőségek ellenőrzése, foreground start/stop, service install/status, cloud check,
végül owner resume. A public móddal egyező configot használd; ne hagyd ki az image/DB
rollback-korlátot vagy a backup ellenőrzését. Az eltérő cloud/engine verzió nem elfogadott.
