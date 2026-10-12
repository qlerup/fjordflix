# FjordFlix LG webOS 0.1.7

LG-klienten vedligeholdes nu i `fjordflix/lg` sammen med Windows- og Xbox-koden.
Bygningen henter den fælles TV-brugerflade fra `xbox/tv`, så LG får kommende
ændringer i afspiller, bibliotek og diagnostik med. LG beholder egen Magic
Remote-navigation, webOS-manifest og formatkontrol via `webOS.deviceInfo`.

## Nyt i denne version

- Næste afsnit vises med nedtælling i de sidste ti sekunder. OK/klik starter
  næste afsnit straks; ellers starter det ved slutningen. Pause og buffering
  standser nedtællingen. Der skiftes også til næste sæson, hvis den findes.
- Opdateret TV-layout, telefonlogin med QR-kode, serverklargjorte trailere,
  undertekstvælger, lydspor og forklaring af den valgte afspilningsplan.
- Afspilningsdiagnostik viser klientens buffer, tabte frames og serverens
  konverteringshastighed. Understøttet video bevares ved forsøg med ny indpakning.
- Original kvalitet skifter ikke stiltiende til videokonvertering.

Telefonlogin på LG kræver, at serveradressen først er indtastet på TV'et.
Xbox' lokale Windows-netværkstjeneste og mpv fra Windows installeres ikke på LG.
HDR, Dolby Vision og lyd afhænger fortsat af TV-model, filprofil og enhedens
formattest; Xbox' TrueHD/DTS-passthrough er ikke et løfte om LG-understøttelse.

## Installation

Opdatér FjordFlix-serveren. TV-API, telefonlogin og trailere er indbygget i
serveren; den gamle `compose.tv.yaml`/`fjordflix_tv.py`-udvidelse skal ikke bruges.
Installér `dist/dk.fjordflix.tv_0.1.7_all.ipk` gennem LG Developer Mode eller webOS
Studio. `dist/app` er det samlede Studio-projekt. Se `TEST-PAA-LG-TV.md`.

## Byg og test

```
npm ci
npm test
npm run build
npm run test:browser
npm run test:next
npm run package
```

Alle leverede scripts kontrolleres som ES5. Browser- og API-tests bruger
testdata; der er ikke udført en fysisk test på et LG-TV i denne opdatering.
