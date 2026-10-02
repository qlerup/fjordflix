# FjordFlix til Windows

Windows 10/11, x64. Installer med `FjordFlix-Setup-0.1.0.exe`, indtast serverens
http(s)-adresse og log ind. Serveren skal have desktop-API'et fra samme udgivelse.
Installationen kræver ikke en separat installation af mpv eller administratoradgang.

Bibliotek og indstillinger indlæses fra serveren og har samme brugerflade som
webappen. Originalfilen åbnes i et separat mpv-vindue med lokal hardwareafkodning,
når pc'en understøtter formatet. Der køres ingen server-transcoding i desktop-mode.
Denne version har mpv's afspilningsbetjening, ikke webafspillerens identiske knapper.
HDR-resultatet afhænger af Windows, skærm, grafikdriver og filformat.

- Vælg lyd og undertekster i filmvisningen før afspilning.
- Under afspilning: mellemrum = pause, pile = søg, F = fuldskærm, J = undertekstspor,
  # = lydspor, Q = luk afspilleren og vend tilbage til biblioteket.
- Position gemmes hvert 15. sekund og ved lukning af afspilleren.
- Skift server via appmenuen, når ingen film afspilles.
- Appen skal have adgang til både webadressen og en eventuel separat medieadresse.
- Installationsfilen er ikke codesignet. Windows kan derfor vise SmartScreen.

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
Output: `desktop/dist/FjordFlix-Setup-0.1.0.exe`.
Se `THIRD-PARTY.txt` og medfølgende licenser for mpv/Electron og deres kilder.

Test: `node smoke.cjs` med Playwright tilgængelig i `NODE_PATH`. Testen bruger
midlertidig database, profil og lydfil, og tester login, native HTTP-afspilning og
gemt position. Den er ikke en test af 4K/HDR-hardware eller installation på en ren pc.

## Afgrænsning og sikkerhed

Renderer kører sandboxed uden Node.js. Native IPC er begrænset til hovedvinduet
på den valgte server. Appen accepterer kun film-ID, position og spornumre fra
websiden, aldrig vilkårlige procesargumenter eller filstier. mpv indlæses uden
brugerkonfiguration/scripts. Video leveres med en kortlivet, film- og loginbundet
billet, der fornyes under afspilning og tilbagekaldes ved afslutning.

Kun serveradressen gemmes af desktop-koden; login håndteres af serverens
HttpOnly-cookie i Electron-sessionen. Der er ingen automatisk appopdatering i 0.1.0.
Opdater via en ny installationsfil; serverens web-UI opdateres separat.
