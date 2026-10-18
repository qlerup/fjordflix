# FjordFlix til Samsung TV

Samsung-klient **0.1.0**, målrettet **2018 og nyere / Tizen 4.0 og nyere**.
Åbn [testguiden](TEST-PAA-SAMSUNG-TV.md) for installation på dit TV.

Appen deler bibliotek og TV-brugerflade med LG og Xbox: Forside med Senest
tilføjet over Se videre, søgning, favoritter, film/serieafsnit, lydspor,
undertekster, trailere, næste afsnit og gemt afspilningsposition. Brugerlogin,
førstegangsoplysninger og telefonlogin bruger serverens eksisterende TV-API.

På TV bruger appen Samsung AVPlay. I PC-forhåndsvisningen bruger den HTML5-video.
Fjernbetjeningens pile/OK/Tilbage og medieknapper understøttes. Ved skift til en
anden app pauses filmen; efterfølgende afspilning genoptages manuelt. Stop/back
frigiver serverstream og mediebillet gennem det fælles TV-flow.

AVPlay, UHD-panel og HDR10 undersøges separat. Kompatibel H.264/HEVC-video
bevares, når kun lyden/indpakningen skal tilpasses. DTS og TrueHD annonceres ikke
som understøttet på 2018-baselinjen; Dolby Vision konverteres til en kompatibel
afspilningsvej ved Automatisk. Original tillader ikke skjult videokonvertering.
Codecgrænser, faktisk HDR/HDMI-lyd og netværk skal verificeres på det konkrete TV.

JavaScript parses som ES5. Layoutet bruger flex/margener frem for CSS-grid og
flex-gap. Native tekstundertekster vises i et tekstoverlay, inklusive korrektion
for streamens tidsforskydning og løbende opdateret VTT. Playwright/API-fixtures
og AVPlay-mocks er automatiske tests; de erstatter ikke en fysisk TV-test.

## Byg

```powershell
npm ci
npm test
npm run build
npm run test:browser
npm run test:next
npm run package
```

`dist/app` er den samlede TV-app. Build henter fælles TV-kode fra `../xbox/tv`,
når den findes; den eksporterede `fjordflix-SAMSUNG-APP`-mappe bruger sin egen
opdaterede snapshot-kopi. `npm run package` laver:

- `dist/FjordFlix-Samsung_0.1.0_UNSIGNED.wgt` — usigneret byggeartefakt.
- `dist/FjordFlix-Samsung_0.1.0_TV-project.zip` — udpakkelig TV-app med guide.
- `dist/SHA256SUMS.txt`.

En usigneret WGT kan ikke installeres direkte på et fysisk TV. Signér med din
egen Samsung-certifikatprofil, hvor TVets DUID er tilføjet:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-and-install.ps1 -CertificateProfile FjordFlixSamsung -TvIp 192.168.1.123
```

Erstat IP-adressen med TVets. Tilføj `-SdkRoot`, hvis Tizen Studio ligger et andet
sted end `C:\tizen-studio`. Certifikater og adgangskoder gemmes i Tizen Studios
private certifikatlager; de skal ikke ligge i projektmappen.

På PC: dobbeltklik `START-PC-SIMULATOR.cmd`, eller kør `npm run build` og
`npm run preview`. Åbn `http://127.0.0.1:8128`. Browseren viser UI og login,
mens AVPlay og fysisk hardware kontrolleres på TVet.

## Platformkilder

[2018-medieformater](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2018-tv-video-specifications.html),
[webmotorer](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html),
[AVPlay](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html)
og [fjernbetjening](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html).
