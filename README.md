# FjordFlix beta 0.1

Logoer og appikoner: [Se den komplette ikonpakke og anvendelse](app/static/logos/README_logo.md).

Privat streamingserver med dansk brugerflade, mørkt biografdesign og reel FFmpeg-transcoding.

## Start og første test

Kræver Docker med Linux-containere. Den medfølgende Compose-fil er sat op til NVIDIA GPU-adgang. På en maskine uden NVIDIA GPU skal linjen `gpus: all` fjernes fra `compose.yaml`; appen bruger derefter CPU-transcoding.

Kør i projektmappen:

```powershell
docker compose up -d --build
```

Åbn http://localhost:8096. Opret selv den første administrator. Der er ingen standardadgangskode. Førstegangsopsætningen låses atomisk, så snart administratoren er oprettet.

1. Vælg **Prøv med en 4K-testfilm**. Den genererer et 12-sekunders 3840 × 2160-testmønster med lyd lokalt.
2. Åbn filmen og vælg **Original kvalitet** for at teste Direct Play, hvis browseren understøtter formatet.
3. Vælg **1080p · 8 Mbit/s** for at teste transcoding. Under afspilning vises faktisk metode, opløsning og encoder.
4. Brug **Upload film** til egne MP4/MKV/MOV/WebM/M4V/AVI/TS-filer. Filmen bliver tilgængelig for alle oprettede brugere.
5. Åbn tandhjulet og opret en invitation. Log ud, vælg **Opret bruger**, og brug koden. Invitationen kan bruges én gang inden for syv dage.

## Installation gennem FjordHub

Standardporten i FjordHub er **8097**, så FjordFlix ikke kolliderer med FjordParcel på 8096. En allerede gemt port ændres ikke automatisk; vælg 8097 ved et nyt installationsforsøg, hvis guiden stadig viser 8096. Solo-installationens standard er fortsat 8096.

Opdater FjordHub til en version med FjordFlix-understøttelse, opdater app-kataloget, og vælg **FjordFlix → Installer**. Guiden spørger om port, filmmappe, lokal arbejdsplads, samtidige konverteringer og valgfri NVIDIA GPU. FjordHub skriver forbindelsesoplysninger og en særskilt app-nøgle automatisk.

| Funktion | Solo-installation | Installeret gennem FjordHub |
| --- | --- | --- |
| Første administrator | Oprettes i FjordFlix | Styres i FjordHub |
| Login | Lokal adgangskode | FjordHub-login eller SSO fra Åbn app |
| Opret brugere og tildel adgang | Invitationer i FjordFlix | FjordHub → Brugere → FjordFlix-adgang |
| Administratorrettigheder | Lokal administrator | Brugerens app-rolle i FjordHub |
| Historik og favoritter | Lokal bruger-ID | Stabil FjordHub-ID, også efter navneændring |
| GPU | Solo-Compose bruger NVIDIA som standard | Valgfri i installationsguiden, ellers CPU |

I Hub-tilstand lagrer FjordFlix ikke Hub-adgangskoder. Lokal brugeroprettelse og invitationer er slået fra, og lokale konti kan ikke bruges som genvej. App-adgang og roller genkontrolleres med højst fem sekunders cache ved nye forespørgsler. Fjernet adgang afviser efterfølgende medieforespørgsler og ugyldiggør sessionen; allerede overførte videodata kan ikke tilbagekaldes. Ved Hub-nedbrud afvises nye beskyttede forespørgsler, når cachen udløber. Brugere med en midlertidig adgangskode skal først skifte den i FjordHub.

Solo-installationen bruger `compose.yaml` og sit eksisterende Docker-volumen. Hub-installationen bruger `docker-compose.yml`, som vælges eksplicit af manifestets `compose_file`, og separate mapper til database/cache og film. En GPU-installation tilføjer `docker-compose.gpu.yml` og FjordHubs automatisk genererede device-fil. `host.docker.internal` gør Hub-API'et tilgængeligt fra app-containeren på både Linux og Docker Desktop. Brug en anden port ved sideløbende solo- og Hub-installation på samme host.

FjordLens og FjordFlix kan få adgang til samme NVIDIA GPU samtidig. De deler hukommelse og kapacitet; FjordHub reserverer ikke en særskilt GPU til hver app og giver ingen automatisk prioritetsgaranti. FjordFlix bruger NVENC til indkodning, mens FjordLens typisk bruger CUDA til AI. Start med to samtidige konverteringer og tilpas efter faktisk belastning. Dekodning, skalering og HDR-tonemapping er fortsat på CPU i betaen.

Eksisterende lokale brugere sammenlægges ikke automatisk med Hub-brugere, selv om navnene matcher. Filmfiler og historik slettes ikke, men migration af eksisterende solo-historik til Hub-identiteter er en separat opgave. Cloudflare-opdelingen af web- og videotrafik er endnu ikke implementeret.

## Telefon som fjernbetjening (lokal test)

Afspilleren bruger egne kontroller med én tidslinje for hele filmen, også ved transcoding. Den har afspil/pause, 10-sekunders spring, lyd, kvalitet og fuld skærm. Kontrollerne skjules efter inaktivitet under afspilning. Mellemrum/K, piletaster, M og F kan bruges, når fokus ikke står i en knap eller et inputfelt. På browsere uden HTML-fuldskærm kan videoens systemafspiller bruges som fallback.

Åbn FjordFlix på pc’en, log ind og tryk **Fjernbetjening** øverst. Scan QR-koden med telefonens kamera og tryk **Forbind til skærmen**. Telefonen skal kunne nå pc’en på det samme lokale netværk. Der installeres ingen app.

- Træk én finger på touchpadden for at flytte FjordFlix-markøren. Tap eller brug **Klik / vælg** for at vælge en film.
- To fingre scroller. Der er også særskilte knapper til scroll, tilbage, afspil/pause, 10 sekunders spring, kvalitet, lyd og søgning.
- QR-koden kan bruges én gang og udløber efter tre minutter. En telefon knyttes til én browserfane, ikke alle brugerens skærme.
- Åbn **Fjernbetjening** igen for at afbryde telefonen eller lave en ny kode. Lukning/genindlæsning af pc-fanen afslutter parringen. En forbindelse varer højst otte timer og kræver, at pc-brugerens login stadig er gyldigt.
- Telefonen får adgang til navigation og afspilning i FjordFlix samt generering af testfilmen, når pc-brugeren er administrator. Den får ikke brugerens login-cookie, adgang til administration eller kontrol over Windows. Knapper, der kræver pc’en, fremhæves ikke som klikbare og viser en forklaring ved fjernklik.
- Ingen Raspberry Pi-image, Wi-Fi-guide eller automatisk QR-visning efter login endnu.

Kopiér `compose.override.example.yaml` til `compose.override.yaml`, og udskift eksempeladressen `192.168.1.100` med pc’ens lokale IP-adresse. Genstart med `docker compose up -d`. QR-koden bruger netværksadressen via `REMOTE_PUBLIC_URL`, mens localhost-adressen stadig virker. Den personlige override-fil ignoreres af Git. Kør `docker compose -f compose.yaml up -d` for opsætning med adgang kun via localhost.

Hvis Windows-firewallen blokerer telefonen, kan `Enable-Local-Remote.ps1 -LocalAddress 192.168.1.100` køres fra en PowerShell startet som administrator. Udskift adressen med pc’ens lokale IP. Reglen tillader kun TCP 8096 til den valgte adresse fra det lokale subnet på et privat netværk. Router- eller Cloudflare-konfiguration er ikke nødvendig til den lokale test.

Parring og touchpad-trafik går via lokal HTTP/WebSocket i denne test. Brug et betroet hjemmenetværk. HTTPS/WSS skal anvendes ved senere adgang over internettet. Mobilbrowserens suspension i baggrunden kan afbryde forbindelsen; den forsøger at genforbinde, når den kommer tilbage.

## Med i betaen

- Login, Argon2-adgangskoder, HttpOnly-sessioncookies og administratoradgang.
- Administratoroprettelse én gang, invitationer og brugeroversigt.
- Upload med fremdrift, filkontrol, diskpladskontrol uden fast filstørrelsesgrænse.
- Automatisk aflæsning af videoformat, opløsning, bitrate, HDR og lydformat samt genererede filmminiaturer.
- Bibliotek, søgning, Min liste og Se videre pr. bruger.
- Enhedsvurdering via browserens codec- og Media Capabilities-understøttelse.
- Direct Play med HTTP byte ranges, Direct Stream med uændret H.264-video og AAC-lyd samt HLS-transcoding til 1080p/720p/480p.
- NVIDIA NVENC, når en reel encoder-test lykkes; ellers CPU-fallback.
- Kvalitetsskift og tidslinje, der kan genstarte transcoding ved en ønsket filmposition.
- Højst tre samtidige konverteringssessioner. Sessioner slettes, når afspilleren lukkes, eller efter to minutter uden heartbeat.
- Film og database gemmes i Docker-volumenet `fjordflix_fjordflix-data` og bevares ved containeropdatering.

## Praktiske begrænsninger i første beta

- Grundfilen binder til `127.0.0.1:8096`; en lokal override kan tilføje pc’ens netværksadresse til telefon-test.
- Hardwareacceleration gælder indkodning med NVENC. Dekodning, skalering og HDR-tonemapping foregår på CPU i denne version.
- Automatisk kvalitet bruger et estimat fra browseren, når det findes; det er ikke en målt gennemstrømning til serveren. Vælg Original manuelt ved en hurtig lokal forbindelse. Ingen løbende adaptiv bitrate under samme afspilning endnu.
- Enhedsmærket før afspilning er en forventning. Browseren kan ikke kortlægge hele skærm/HDMI/lydkæden. Ved fejl i Direct Play forsøges transcoding.
- HDR konverteres konservativt til SDR i denne version. FFmpeg-tonemapping er implementeret, men farvegengivelse på rigtige HDR-film og forskellige skærme er endnu ikke visuelt valideret.
- Lydspor og indlejrede undertekster vælges i filmdetaljer eller under **Lyd og tekst** i afspilleren. Standardlydsporet vælges først, og undertekster starter slået fra. HLS konverterer det valgte lydspor til stereo AAC.
- SRT, ASS/SSA, WebVTT og MP4-tekstundertekster udtrækkes til WebVTT og vises af browseren uden at kræve videokonvertering. ASS-layout, skrifttyper og effekter bevares ikke fuldt ud. PGS, DVD/VobSub og DVB-undertekster brændes ind og kræver videokonvertering. Ukendte undertekstformater vises som utilgængelige.
- Eksisterende filers sporlister opdateres i baggrunden ved serverstart eller hentes ved åbning af filmdetaljer. Undertekstfiler caches lokalt under `DATA_DIR/subtitles` og kræver login. Valg af spor bevares ved søgning og kvalitetsskift, men nulstilles, når en anden film eller et andet afsnit åbnes.
- HLS-filer produceres løbende i én valgt kvalitet. Afspillerens nederste filmtidslinje understøtter spring frem i endnu ikke konverterede dele af filmen. Browserens indbyggede tidslinje viser kun den tilgængelige HLS-del.
- Upload kan ikke genoptages efter netværksafbrydelse endnu.
- Kort testvideo validerer funktionalitet, ikke maksimal kapacitet eller langvarig streaming med flere seere. Lokalt betamiljø; internetdrift kræver bl.a. HTTPS og yderligere driftshærdning.

## Drift og test

```powershell
docker compose ps
docker compose logs --tail 100 app
docker compose stop
docker compose start
docker compose exec -T app python -m pytest tests/test_integration.py -q -s
```

Integrationstesten opretter altid en separat midlertidig database og testfilm og ændrer ikke brugerens bibliotek. Den tester opsætningslås, invitationer, rettigheder, CSRF, byte ranges, reel 4K → 1080p-transcoding, FFprobe-kontrol af output, HLS-adgang, seek, oprydning, upload og isoleret brugerhistorik.

`tests/browser_smoke.py` anvender en separat lokal Playwright-browser og forventer en frisk, midlertidig QA-container på port 8097. Skærmbilleder ligger i `test-results/`. Ingen testkonto oprettes i installationen på 8096.

`tests/test_remote.py` tester engangskoder, udløb, skærmrettigheder, WebSocket-oprindelse, filtrering af kommandoer og oprydning. `tests/browser_remote.py` tester to separate browserkontekster, afkoder den faktisk viste QR-kode med OpenCV og bruger touch-events fra telefonsiden til at vælge og afspille en film på pc-siden.

### Web via Tunnel, video direkte

Administratorer kan vælge **Server → Direkte videoforbindelse**. Webadressen foreslås fra FjordHub; videoadressen kræver en separat, fungerende HTTPS-indgang uden Cloudflare-proxy. Se [opsætning og Docker-konfiguration til Caddy](deploy/direct-media/README.md). Funktionen er slået fra som standard og ændrer ikke automatisk DNS eller routeren.

### Flere testfilm

Åbn tandhjulet i FjordFlix og vælg **Tilføj 3 testfilm** under Testbibliotek.
Serveren opretter Fjordens ro (30 sekunder, 1080p), Det sidste sollys (1 minut,
1080p) og Langt fra jorden (2 minutter, 4K). Filmene har originale illustrationer
med langsom bevægelse og et lydløst lydspor. De tester bibliotek, afspilning og
seek, men er ikke en belastningstest svarende til en film med høj bitrate.
Oprettelsen fortsætter, når dialogen lukkes; eksisterende testfilm genbruges.

**Tilføj 120 Mbit/s-testfilm** opretter også Bitstorm: 60 sekunders syntetisk
4K/24-video med bevægelse og støj, H.264 og cirka 120 Mbit/s (omkring 900 MB).
Oprettelsen kræver 2 GB ledig plads og kontrollerer den faktiske bitrate før
filmen føjes til biblioteket. Vælg **Original** for at teste den fulde bitrate
eller **1080p** for at teste transcoding. Automatisk kvalitet kan nedskalere
ud fra browserens netværksestimat. Testen svarer ikke til alle egenskaber ved
en UHD-remux, der eksempelvis kan bruge HEVC, HDR og andre lydformater.

### Teknisk grundlag

Python/FastAPI, SQLite med WAL, FFmpeg/FFprobe og en lokal kopi af HLS.js. Ingen eksterne webtjenester er nødvendige under brug. Afspilning bruger FFmpegs [HLS-muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2).
# Automatiske filmoplysninger (TMDB)

Efter upload søger FjordFlix efter filmen og tilføjer titel, beskrivelse, år,
genrer, TMDB-rating, cover og baggrundsbillede. Dansk foretrækkes; mangler
beskrivelsen på dansk, bruges engelsk. Oplysninger og billeder gemmes lokalt.
Filens tekniske data, afspilning og selve videofilen ændres ikke.

Opret en TMDB-konto og hent **API Read Access Token** eller API-nøglen under
https://www.themoviedb.org/settings/api. Åbn tandhjulet i FjordFlix →
**Filmoplysninger · TMDB**, indsæt nøglen, og tryk **Gem API-nøgle**.
Ændringen gælder straks for nye uploads, uden genstart. Kun administratorer
kan læse opsætningsstatus, gemme eller fjerne nøglen. Den gemte nøgle sendes
aldrig tilbage til browseren. Nøglen gemmes i appens lokale database (ikke
krypteret); beskyt derfor datamappen og backups mod uvedkommende.
En gemt nøgle har forrang over miljøvariablen. Fjernelse slår opslag fra,
også hvis en ældre miljøvariabel stadig er sat. Eksisterende filmdata bevares.

Alternativt kan tokenet stadig sættes i installationens lokale `.env`:

```dotenv
TMDB_READ_ACCESS_TOKEN=dit_read_access_token
```

Genopret app-containeren efter ændringen. Begge Compose-filer understøtter
variablen. Tokenet bruges kun på serveren og må ikke committes til GitHub.
TMDB kræver accept af sine vilkår; udvikler-API'et er gratis til ikke-kommerciel
brug med kildeangivelse (https://developer.themoviedb.org/docs/faq).
Før aktivering skal et godkendt TMDB-logo også tilføjes i appens sektion
"Om filmdata", jf. https://www.themoviedb.org/about/logos-attribution.
Kildeangivelsen og den krævede erklæring er allerede indsat.

Brug helst filnavne som `The.Matrix.1999.1080p.mkv`. Årstal hjælper med at
skelne genindspilninger. Uklare eller manglende matches beholder filnavn og
videostillbillede. Uden token eller ved API-fejl lykkes upload stadig, og
brugerfladen fortæller, at metadata ikke blev hentet. Allerede uploadede film
får ikke nye TMDB-oplysninger automatisk. Testfilm springer opslaget over.

Administratorer kan åbne en film eller et afsnit og vælge **Hent oplysninger igen**
uden at uploade filen på ny. Det seneste resultat vises i filmdetaljerne, med
særskilte beskeder for afvist API-nøgle, timeout, netværksfejl og manglende match.
Et fejlet genforsøg bevarer eksisterende oplysninger og billeder. Manuelt
redigerede oplysninger og billeder beskyttes mod automatisk genhentning.
Ved et uklart match vises forslag fra TMDB med plakat, titel, årstal og kort
beskrivelse. Administratoren kan vælge det rigtige match eller rette søgetitlen
og tilføje startår. Valget huskes; sæson, afsnitsnummer og afspilningshistorik
bevares. Forslagenes plakater vises fra TMDB's billedserver, mens billederne
for det valgte match fortsat gemmes lokalt.

## Serier, sæsoner og afsnit

Uploadvinduet understøtter valg af flere filer og drag-and-drop. En uploadkø
viser fremdrift og resultat for hver fil, uploader én ad gangen og fortsætter
efter fejl. Ingen fast grænse for filstørrelse. Vinduet kan lukkes under upload;
browserfanen skal holdes åben, indtil køen er færdig.

Filer sendes som separate HTTP-requests på højst 2 MiB (2.097.152 bytes),
så hele videofilen ikke rammer Cloudflares grænse pr. request. Serveren samler
bidderne uden at ændre videoen. Afbrudte requests forsøges igen automatisk;
**Prøv igen** fortsætter fra serverens gemte position, så længe samme browserfane
er åben. Videobehandling og TMDB-opslag kører i baggrunden med statusvisning.
Uafsluttede uploads ryddes op efter 48 timer uden aktivitet. Uploadsessionerne
gemmes på disk; løsningen bruger én server-worker som i den medfølgende Docker-opsætning.

Afsnit vises i en vandret karrusel med billede, afsnitsnummer, titel, spilletid
og set-status. Vælg sæson, og brug swipe, scroll, pileknapper eller tastaturets
piletaster til at finde et afsnit. Kun uploadede afsnit vises.
TMDB's afsnitsbillede (`still_path`) hentes og gemmes separat fra serieplakaten.
Hvis det mangler, bruges et stillbillede fra den enkelte videofil. Ældre afsnit
kan hente TMDB-billedet med **Hent oplysninger igen**.

Upload én videofil pr. afsnit. Navne som `The.Show.S02E10.1080p.mkv`,
`The Show s02e10.mp4` og `The Show 2x10.mkv` genkendes automatisk.
`S00E01` bruges til specialafsnit. Et startår før afsnitskoden hjælper
med genindspilninger: `The Show (2020) S02E10.mkv`.

Serieopslag bruger TMDB's TV-katalog, ikke filmsøgning. Der hentes seriecover,
banner, seriebeskrivelse, genrer og rating samt titel, beskrivelse og dato for
det konkrete afsnit. Dansk foretrækkes med engelsk beskrivelsesfallback.
Mangler TMDB eller netværk, bevares lokal genkendelse af serien og afsnittet.

**Hjem** viser én flise pr. serie og de enkelte film. **Film** og **Serier**
filtrerer biblioteket. Åbn serien for at vælge sæson og afsnit; vælgerne viser
kun uploadede filer i numerisk rækkefølge. Næste afsnit går videre til den
næste uploadede fil, også på tværs af sæsoner. Afspilning og **Se videre**
gemmes pr. fil; en favoritsat episode viser serien under **Min liste**.
Ældre filer med en genkendelig afsnitskode grupperes lokalt uden at omskrive
databasen. Kombinerede filer med flere afsnit understøttes ikke som flere
selvstændige afsnit; del dem eller ret den registrerede episode manuelt.

## Manuel rettelse

Administratorer kan åbne **Rediger oplysninger** på en film eller et afsnit
og ændre visningstitel, type, beskrivelser, genrer, dato og rating. For serier
kan serienavn, startår, sæson og afsnit også rettes. Rettelser gælder den
valgte fil, ikke automatisk resten af serien. Lokale afsnit grupperes efter
serienavn/startår; sikre TMDB-matches grupperes efter serie-ID. Manuel
klassifikation respekteres, selv hvis filnavnet peger på noget andet.

**Hent oplysninger igen** i redigeringsvinduet søger med de indtastede felter,
også før de er gemt. Film bruger titel og eventuelt udgivelsesår; serier bruger
serienavn, startår, sæson og afsnit. Ved tvivl vises mulige matches i vinduet.
Et match gemmer TMDB-oplysninger og billeder; uden match bevares de indtastede
felter, så søgningen kan justeres. Dette er en eksplicit genhentning, som også
kan erstatte tidligere manuelt gemte oplysninger.

Cover og banner kan erstattes med JPEG, PNG eller WebP (maks. 8 MB / 16 MP).
Billeder valideres og konverteres til JPEG på serveren. Tomme billedfelter
beholder eksisterende billeder. Tekst gemmes før billeder; ved billedfejl
vises det tydeligt, at teksten allerede er gemt. Videofil, tekniske data,
favoritter og afspilningshistorik ændres ikke af redigeringen. Der er ingen
automatisk baggrundsopdatering, der overskriver manuelle oplysninger.



### LG webOS og andre TV-klienter

Serveren har et indbygget token-API til selvstændige TV-apps. Det følger med ved
normal opdatering via FjordHub; TV-appens kildekode og installationsfil ligger
ikke i dette repository.

- `GET /tv-api/info` viser API-versionen uden login.
- `POST /tv-api/login` modtager `name` og `password`. Eksisterende FjordFlix- eller
  FjordHub-login og loginbegrænsning genbruges. Svaret indeholder `token` og
  `expires_in`; der sættes ingen cookie. Brug HTTPS til login over internettet.
- TV-klienten sender `Authorization: Bearer <token>` til `/tv-api/state`,
  `/tv-api/movies` og de tilsvarende endpoints for billeder, favoritter,
  afspilningsposition, afspilning og stream-heartbeat. Tokenet har samme
  syvdages levetid som en normal session; serveren gemmer kun dets hash.
- API'et kræver token, også selv om forespørgslen indeholder en gyldig
  browsercookie. CORS understøtter pakkede apps uden at tillade cookie-credentials.
  Det eksisterende browser-login og dets CSRF-kontrol er uændret.
- Afspilning returnerer en separat, kortlivet videobillet under `/tv-media/`.
  Den gælder kun én film/stream, fornyes via `/tv-api/media/heartbeat` og kan
  tilbagekaldes via `/tv-api/media/revoke`. `POST /tv-api/logout` ugyldiggør
  TV-sessionen og dens billetter. FjordHub-adgang kontrolleres fortsat på serveren.

Ved separat mediedomæne skal reverse proxy videresende **både `/media/*` og
`/tv-media/*`** til FjordFlix. Eksemplet i `deploy/direct-media/Caddyfile`
understøtter begge. En eksisterende FjordHub-mediegateway skal have TV-ruten
tilføjet, hvis den endnu ikke findes. Undlad at logge videobillet-URL'erne.

En installation med den tidligere separate `fjordflix_tv.py`-udvidelse kan
fortsat køre under opdateringen. For at bruge det indbyggede API skal dens
TV-Compose-override fjernes fra `COMPOSE_FILE`, hvorefter kun app-servicen
genoprettes med den normale FjordHub-konfiguration. Bevar øvrige Compose-filer,
data- og mediemapper, GPU-indstillinger og mediegatewayens TV-rute.

Test: `python -m pytest tests/test_tv.py tests/test_media_delivery.py tests/test_hub.py -q`.
Tests dækker token-login, cookieadskillelse, CORS, sessionsudløb, FjordHub-revokering,
filmposition, favoritter og videobillettens rettigheder. Fysisk TV-afspilning skal
desuden afprøves med den separate klient.

### AirPlay (Safari / iPhone / iPad / Mac)

Start filmen, vælg lyd og undertekster, og tryk på AirPlay-ikonet ved siden af fuld skærm. Knappen vises i browsere med WebKits AirPlay-vælger og native HLS. Safari får en AirPlay-klar HLS-stream allerede ved lokal afspilning, så både knappen og systemets AirPlay-vælger bruger samme kilde. Andre browsere beholder deres normale afspilning.

- Det valgte lydspor sendes som AAC-stereo. Understøttet H.264-video kan bevares uden ny videokodning, når undertekster ikke brændes ind.
- Tekstbaserede undertekstspor (fx SRT/SubRip) konverteres til WebVTT og leveres som en separat HLS-rendition med det valgte sprog aktiveret. Det kræver ikke ny videokodning alene på grund af underteksterne. Understøttet H.264-video bevares ved Original/tilstrækkelig båndbredde; andet format eller lavere kvalitet kan stadig kræve transcoding.
- Under **Lyd og tekst** findes **Indbrænd undertekster, hvis TV’et ikke viser dem** som manuel reserve. Den kræver videokonvertering og nulstilles ved åbning af en ny film. Billedbaserede spor (fx PGS) bruger fortsat indbrænding. Automatisk kontrol af, hvad TV’et faktisk viser, er ikke mulig fra browseren.
- Skift af lyd, tekst eller kvalitet genstarter streamen fra den aktuelle position. Det kan give en kort pause. Undertekster følger originalfilens tidslinje efter spoling.
- TV'et bruger en tilfældig billet, der kun gælder denne stream, uden login-cookies. TV'ets forespørgsler holder billetten aktiv, når telefonen sover. Billetter har 10 minutters inaktivitetsfrist og en absolut grænse på filmens varighed plus en time (højst 24 timer); log ud eller luk afspilleren for at stoppe adgangen.
- Med direkte video konfigureret bruges den eksisterende videoadresse og dens adgangskontrol. Ellers bruges samme adresse som hjemmesiden. TV'et skal kunne nå adressen; eksterne loginporte som Cloudflare Access kan blokere TV'et og kræver en tilgængelig videoadresse.

Verifikation: `python -m pytest tests/test_airplay.py tests/test_tracks.py tests/test_media_delivery.py -q` bruger rigtig FFmpeg til at kontrollere valgt lyd, separate tekstspor, bevarede H.264-billeddata, synkronisering før/efter spoling, indbrændingsreserven og adgang uden cookies. `node --test tests/test_airplay_ui.cjs` kræver `jsdom` og tester UI med simulerede WebKit-API'er. Den trådløse forbindelse skal desuden afprøves på fysisk Apple-udstyr: forbind TV, lås telefonen i mindst tre minutter, prøv spoling og skift af spor, undertekster Fra, separate undertekster og indbrændingsreserven, afbryd AirPlay, og kontrollér at lukning af afspilleren stopper streamen.
