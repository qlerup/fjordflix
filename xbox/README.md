# FjordFlix til Xbox

## 0.1.11: original TrueHD/DTS-lyd

Kræver også den nye FjordFlix-server (`xbox-matroska-audio`). Xbox-appen leverer
det valgte TrueHD/DTS-spor uændret gennem Matroska til systemafspilleren i stedet
for AAC-stereo. Kompatibel HEVC/HDR10-video bevares, herunder et bekræftet HDR10-basislag.
Spoling genstarter streamen på den ønskede position. Streamen gemmes ikke som en
hel midlertidig film. Ved afspilningsfejl skifter appen ikke lydsporet til stereo.

Afspilningsdetaljer viser det leverede codec og kanalantal. Dette bekræfter
serverens output, ikke HDMI-signalet: Atmos/DTS-output skal kontrolleres på
soundbaren/receiveren med Xboxens **Tillad passthrough** slået til.
Serverens bevarelse af komprimerede lydpakker er testet med FFmpeg; fysisk
Xbox/HDMI-afspilning af denne transport er endnu ikke verificeret.

Selvstændig UWP-app med samme TV-brugerflade og token-API som FjordFlix til LG.
Mål: Xbox One, One S, One X, Series S og Series X med opdateret systemsoftware.
Xbox 360 og den oprindelige Xbox understøttes ikke.

**Start med [TEST-PAA-XBOX.md](TEST-PAA-XBOX.md).**

## Færdige filer

- `dist/FjordFlix-Xbox_0.1.11.appx`: signeret installationspakke til Developer Mode.
- `dist/FjordFlix-Xbox.cer`: offentligt udviklercertifikat, hvis installationsværktøjet beder om det.
- `dist/SHA256SUMS.txt`: kontrolsum for APPX-filen.
- `dist/app/`: alle filer, der er pakket i appen.

Pakken er arkitekturneutral, har ingen eksterne framework-afhængigheder og bruger
Xbox' indbyggede JavaScript/UWP-runtime. Der skal ikke installeres LG-værktøjer,
Visual Studio eller WebView2 separat på Xbox. Ingen app er publiceret til Store.

## Funktioner

Serveradresse og login, film/serieafsnit, søgning, sideinddeling, favoritter,
fortsæt-afspilning, lydspor, tekstundertekster og afspilningskvalitet.
**Log ind via telefonen:** vælg knappen med tomme felter på Xboxen og scan
QR-koden. Skriv serveradresse og FjordFlix-/FjordHub-login på telefonen og
tryk **Log ind på Xbox**. Appen åbner biblioteket automatisk. Login-siden udløber efter
fem minutter; B eller Tilbage annullerer. Almindeligt login på Xbox er stadig muligt.
Controller: D-pad/venstre stick navigerer, A vælger, B går tilbage, X/Menu pauser,
LB/RB spoler 30 sekunder, Y fokuserer søgning. A åbner tekstfelter til Xbox-tastaturet.
Afspilning sættes på pause, når appen skjules; ved UWP-suspendering forsøger appen
at gemme position og frigive streamingressourcer inden for et kort tidsbudget.
Media remote og Xbox' systemmedieknapper er tilkoblet.

Appen husker serveradresse og token, aldrig adgangskoden. Tokenets levetid er
den eksisterende TV-API's syv dage. Log ud tilbagekalder tokenet på serveren.

## Afspilning og status

Appen bevarer understøttet **4K-video**. Den spørger afspilleren om codec-understøttelse.
Kompatibel 4K HEVC/MP4 afspilles direkte i original opløsning; HEVC i MKV eller med
et inkompatibelt lydspor kan ompakkes til HLS/fMP4 med original video og konverteret lyd.
Kompatibel VP9/WebM kan også afspilles direkte. **Original og 4K tillader ikke
videokonvertering**: en inkompatibel plan stoppes med en forklaring før afspilning.
Ved afvisning forsøger appen først at tilpasse indpakning og lyd med bevaret video.
Automatisk kan derefter bruge H.264-konvertering til højst 1920 × 1080 og 8 Mbps.
Brugeren kan selv vælge 1080p eller 720p. Afspilningsdetaljer på filmsiden viser
format, decoder-svar, serverunderstøttelse, plan og seneste afspilningsfejl.

4K afhænger af konsol, filformat og den faktiske UWP-afspiller. Microsoft angiver
HEVC op til 4K på One S/One X/Series S/X; den oprindelige Xbox One har andre
hardwaregrænser. H.264 er dokumenteret op til 1080p. Serverens nuværende
videotranscoding bruger H.264, så 4K-afspilning på Xbox bør bruge kompatibel HEVC
eller VP9 direkte, eller bevare HEVC-videoen under ompakning. Et manuelt 4K-valg
stoppes med en forklaring, hvis den originale video ikke kan bevares.
Serveren kræver FFmpeg for ompakning/konvertering. Billedbaserede undertekster
kræver indbrænding og kan derfor forhindre, at original HEVC bevares.
4K-badget i biblioteket beskriver kildefilen, ikke appens afspilningsopløsning.
HDR10/HLG i kompatibel HEVC bevares ved direkte afspilning eller video-copy;
HDR-output til TV'et er endnu ikke verificeret. Dolby Vision og Atmos-passthrough
er ikke garanteret.

APPX er valideret med Microsoft MakeAppx, signeret, og signaturens certifikat er
kontrolleret. Enhedstests og Chromium-browsertests består, inkl. login, navigation,
afspilningsfallback og undertekster. **Der er endnu ikke testet på en fysisk Xbox.**
Xbox-tastatur, native HLS, systemmedieknapper og standby skal derfor verificeres
på konsollen, før kompatibilitet kan bekræftes.

## Server

Brug samme `/tv-api` og `/tv-media` som LG-appen. **0.1.10 kræver også den opdaterede
FjordFlix-server for HEVC Direct Stream**: serverens `/tv-api/info` skal indeholde
`features: ["xbox-hevc-fmp4"]`. Et fungerende login alene bekræfter ikke denne støtte.
Rettelserne findes i søsterprojektet `fjordflix/app/main.py` og `fjordflix/app/tv.py`.
Se [SERVER-SETUP.md](SERVER-SETUP.md). Ingen kørende server er opdateret fra dette build.

Telefonlogin kræver desuden `phone-login-v1` i serverens `features`, den nye
`app/tv_pairing.py` og `app/static/tv-login.html`, `.css` og `.js`. Den bruger serverens
eksisterende login til lokale brugere og FjordHub. QR-generering sker på din server
uden eksterne QR-tjenester. QR-koden indeholder kun godkendelseskoden; en separat,
tilfældig enhedskode holdes i Xbox-appens hukommelse. Telefonen får ingen Xbox-token,
og databaseposter indeholder kun hashes. Godkendelse kan kun hentes én gang.

## Byg og test

```powershell
npm ci
npm run build
npm test
npm run test:browser
npm run test:phone
npm run package
```

`package` henter Microsofts SDK-pakkeværktøjer fra officiel NuGet, hvis nødvendigt.
`test:phone` bruger søsterprojektet `fjordflix` og dets `.venv/Scripts/python.exe`
(eller `FJORDFLIX_TEST_PYTHON`). Testen starter en isoleret lokal server med midlertidige
brugere, aflæser den faktiske QR-kode og gennemfører login fra en separat mobilbrowser.
Et selvsigneret certifikat oprettes i den aktuelle brugers personlige certifikatlager
og genbruges til efterfølgende builds. Det installeres ikke som et betroet rodcertifikat.
`.signing/` og `.tools/` er lokale byggeoplysninger og skal ikke deles.
Pakkens signerede identitet er `FjordFlix.Xbox`, udgiver `CN=FjordFlix Development`.

## Microsoft-reference

- [Xbox Developer Mode](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/devkit-activation)
- [Xbox Device Portal](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/device-portal-xbox)
- [JavaScript/UWP-manifest](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-f-application)
- [Xbox-medieformater](https://learn.microsoft.com/en-us/windows/uwp/apps-for-xbox/supported-technologies)


## Login fra telefon uden serveradresse på Xbox · 0.1.10

Vælg **Log ind via telefonen** med tomme felter på Xboxen. Appen åbner en
midlertidig HTTP-side på Xboxens lokale IPv4-adresse og en automatisk valgt port.
Scan QR-koden på telefonen, og indtast FjordFlix-server, brugernavn og adgangskode.
Serveradressen kan være et domæne, en fuld http(s)-adresse eller en privat IP med port.
Telefon og Xbox skal være på samme lokalnetværk; gæstenetværk med klientisolering
kan ikke forbinde til Xboxen.

Siden lukker efter vellykket login, annullering, app-suspend eller fem minutter.
QR-adressen har en tilfældig engangshemmelighed. Den lokale side bruger HTTP på
lokalnetværket. Adgangskoden videresendes til den valgte servers almindelige TV-login
og gemmes ikke; kun serveradresse og det returnerede Xbox-token gemmes som før.
En serveropdatering er ikke nødvendig, når det normale TV-login virker.

Den tidligere serverbaserede QR-parring bevares til browser-simulatoren.
På den rigtige Xbox bruges den lokale side, også når serverfeltet er tomt.
Kildekoden findes også under `xbox/` i FjordFlix-repositoryet på GitHub.

Test: `npm test`, `npm run test:browser`, `npm run test:phone`.
Telefon-testen afprøver rigtig TCP/HTTP og browser med WinRT-socket-adapteren
simuleret via Node. Firewall og indgående forbindelser på fysisk Xbox skal
verificeres efter installation af APPX.
