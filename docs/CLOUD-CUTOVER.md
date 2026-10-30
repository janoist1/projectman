# Visszaállás EC2 cloud + Mac engine módból Mac single módba (PM-674)

## Stop és visszaállás: egyetlen writer

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

4. Csak most indíts single-t az owner által jóváhagyott, **az átvett DB
   sémáját támogató** Mac buildből, annak checkoutjából:

   ```sh
   npm run live -- install --root <LIVE_ROOT> --home <SOURCE_HOME> --port 4800
   npm run live -- status --home <SOURCE_HOME>
   ```

   Az install a szerverszolgáltatást elindítja és resume-ot végez; ezért csak activate és a
   rollback-adatellenőrzés után fusson. A régi image vagy `cloud rollback` önmagában nem
   fordít vissza sémamigrációt. Ha régebbi build kell, az [AWS point-in-time recovery](AWS.md#restoring-the-database-to-a-point-in-time)
   útját előbb izolált másolaton igazold, és nevezd meg az elvesző DB/fájl időszakot,
   kártyákat/üzeneteket/uploads-ot az owner jóváhagyásában.

5. A visszaállás ellenőrzése után a downloaded copy (`<RETURN_DATA>`) eltávolítása vagy offline titkosított
   archiválása az owner külön döntése szerint. Új AI session előtt ne maradjon titkos másolat szabadon
   olvasható könyvtárban.
   A régi `pre-hybrid` archívumot csak ellenőrzött single működés után takarítsa az owner.
   EC2/EBS/IPv4/bucket/IAM erőforrások nem törlődnek a rollbacktől; költségük és későbbi
   megszüntetésük külön jóváhagyott művelet.

**DNS-delegáció visszaváltás nincs az eszközökben** (PM-1116). A `dns switch --back` kivezetésre került
(az utolsó commit, amelyben megvolt: `358bb7c7` a `main`-en, `retired-migrate-dns` taggel), ezért az [AWS.md](AWS.md#dns-pm-537-one-off-move-retired-in-pm-1116)
sem ír elő ilyen lépést. A régi Route 53 hosted zone az owner döntéséig megmarad; ha a delegációt mégis
vissza kell állítani, az az owner kézi lépése a Route 53 Domains felületén, utána levél- és
kézbesítés-ellenőrzéssel.
