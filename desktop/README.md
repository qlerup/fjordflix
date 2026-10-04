# FjordFlix til Windows

Windows 10/11, x64. Installer med `FjordFlix-Setup.exe`, indtast serverens
http(s)-adresse og log ind. Serveren skal have desktop-API'et fra samme udgivelse.
Installationen kræver ikke en separat installation af mpv eller administratoradgang.
Bibliotek og afspiller starter i fuldskærm. F11 skifter bibliotekets fuldskærm,
F skifter afspillerens. Alt+F4 lukker vinduet. Afspillerens indbyggede træk af
vinduet er slået fra, så musen kun betjener knapper, tidslinje og lydstyrke.

Bibliotek og indstillinger indlæses fra serveren og har samme brugerflade som
webappen. Originalfilen åbnes i et separat mpv-vindue med lokal hardwareafkodning,
når pc'en understøtter formatet. Der køres ingen server-transcoding i desktop-mode.
Afspilleren har sin egen FjordFlix-betjening med tidslinje, ti sekunders spring,
lydstyrke og menuer til lydspor og undertekster. Knapper skjules under afspilning
og vises ved musebevægelse eller pause. Browserens afspiller ændres ikke.
HDR-resultatet afhænger af Windows, skærm, grafikdriver og filformat.

Dolby Digital, Dolby Digital Plus, TrueHD og DTS/DTS-HD forsøges sendt uændret
via WASAPI til Windows' valgte lydudgang. Det bevarer også Atmos/DTS:X-data,
når HDMI-forbindelsen og lydanlægget understøtter det oprindelige format.
Vælg HDMI-lydudgangen i Windows. Hvis WASAPI ikke kan starte lydudgangen, forsøger
appen én gang at genåbne det valgte lydspor med lokal PCM-afkodning. Video,
position, pause og undertekster bevares. Hvis PCM også fejler, vises en fejlbesked.
PCM er ikke Atmos-passthrough. Serveren konverterer ikke
desktop-lyden. Passthrough er endnu ikke verificeret med et fysisk Atmos-anlæg.

- Vælg lyd og undertekster i filmvisningen før afspilning.
- Under afspilning: mellemrum = pause, venstre/højre = ti sekunder, F = fuldskærm, J = undertekstspor,
  # = lydspor, Q = luk afspilleren og vend tilbage til biblioteket.
- A/S åbner lyd/undertekster. Tab og Enter betjener knapperne; pil op/ned og
  musehjulet navigerer lange sporlister. Escape lukker menuen, forlader fuldskærm
  eller vender tilbage til biblioteket.
- Position gemmes hvert 15. sekund og ved lukning af afspilleren.
- Skift server via appmenuen, når ingen film afspilles.
- Appen skal have adgang til både webadressen og en eventuel separat medieadresse.
- Installationsfilen er ikke codesignet. Windows kan derfor vise SmartScreen.

## Fejlfinding af afspilning

Hvis afspilleren bliver stående ved indlæsning, brug appmenuen **FjordFlix → Gem
afspilningsdiagnostik** mens problemet er til stede. Rapporten indeholder appversion,
filmnavn, startposition, buffer-/seek-status og de seneste mpv-advarsler. Medieadresser
og videobilletter skjules. Ved afspilningsfejl gemmes også en lokal rapport som
`playback-diagnostics.json` i appens brugerprofil. Ingen rapport sendes automatisk.
Fejl fra åbning af filmen og mpv's konkrete slutfejl vises nu i fejlbeskeden.

## Byg

På Windows med Node.js og PowerShell:

```powershell
cd desktop
npm ci
./prepare.ps1
npm test
npm run dist
```

`prepare.ps1` henter den fastlåste officielle mpv-build og verificerer SHA256.
Output: `desktop/dist/FjordFlix-Setup.exe`, `.blockmap` og `latest.yml`.
Se `THIRD-PARTY.txt` og medfølgende licenser for mpv/Electron og deres kilder.

Test: `node smoke.cjs` med Playwright tilgængelig i `NODE_PATH`. Testen bruger
midlertidig database, profil og lydfil, og tester login, native HTTP-afspilning og
gemt position. Den er ikke en test af 4K/HDR-hardware eller installation på en ren pc.

WASAPI-regression: Sæt `FFMPEG` til ffmpeg.exe og `FJORDFLIX_TEST_WASAPI=1`,
og kør `node --test desktop/tests/audio-fallback.cjs` fra projektroden. Testen
afspiller en genereret, lydløs TrueHD-video gennem Windows' valgte lydudgang
og kræver en udgang, som afviser TrueHD-passthrough. Den kontrollerer, at PCM
starter og tidspositionen fortsætter uden at genindlæse videoen. Den normale
testsuite kræver ikke en fysisk lydudgang.

Undertekstregression: `node desktop/test-subtitle-switch.cjs <ffmpeg.exe> [supsample.mkv]`
fra projektroden. Den valgfrie PGS-testfil findes hos
https://samples.ffmpeg.org/sub/PGS/supsample.mkv og gemmes ikke i repositoryet.
Testen genererer MKV-filer og kontrollerer synlige PGS-billeder ved sporskift,
tekstspor, pause og position. MKV-undertekster bruger op til ti sekunders preroll
for at finde displaydata før det aktuelle keyframe; det kan øge læsning ved seek.

## Afgrænsning og sikkerhed

Renderer kører sandboxed uden Node.js. Native IPC er begrænset til hovedvinduet
på den valgte server. Appen accepterer kun film-ID, position og spornumre fra
websiden, aldrig vilkårlige procesargumenter eller filstier. mpv indlæses uden
brugerkonfiguration eller brugerscripts; kun den medfølgende `player.lua` indlæses.
Video leveres med en kortlivet, film- og loginbundet
billet, der fornyes under afspilning og tilbagekaldes ved afslutning.

Kun serveradressen gemmes af desktop-koden; login håndteres af serverens
HttpOnly-cookie i Electron-sessionen. Fra 0.1.1 findes **Søg efter opdateringer** i
appmenuen og topbaren (topbaren kræver den opdaterede server). Opdateringer hentes
fra offentlige GitHub Releases via electron-updater. Kun stabile, nyere versioner
tilbydes. Download og installation kræver hver sin bekræftelse. En igangværende film
blokerer installationen; afslut filmen og tryk på opdateringsknappen igen.
Appen rapporterer afspilningsstatus, position og valgte spor til administratorens
oversigt under Indstillinger → Aktive streams. Det kræver en opdateret server.
Downloadets SHA512 kontrolleres mod udgivelsens manifest. Installationsfilerne er
fortsat ikke codesignet. Version 0.1.0 skal opdateres manuelt én gang.

## Udgiv en opdatering

Push ændringer i `desktop/` til `main`. Workflowet tester og bygger automatisk
Windows-installeren og udgiver installer, blockmap og `latest.yml` på GitHub.
Downloadknappen og appens opdateringsknap bruger den nye release.

Versionsnummeret hæves automatisk fra den højeste eksisterende version. Pakke og
lockfil får samme version i bygget; der kræves ingen versionscommit eller manuelt
tag. Et højere versionsnummer i package.json bruges, hvis det er angivet manuelt.
Udgivelser køres én ad gangen, og tagget peger på den commit, der blev bygget.
Workflowet kan også startes manuelt. Ændringer alene i serverens web-UI udgiver
ikke en ny pc-installation, da brugerfladen indlæses direkte fra serveren.
