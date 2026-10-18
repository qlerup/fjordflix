# Test FjordFlix på Samsung TV fra 2018 og frem

Målplatformen er Samsung Smart TV med **Tizen 4.0 (2018) eller nyere**. Find
modelkode og softwareversion under **Indstillinger → Support → Om dette TV**
(på nogle modeller **Kontakt Samsung**). Opdatér TVets firmware først.
Samsung angiver årgangenes Tizen-versioner i
[webmotorspecifikationen](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html).

## 1. Server og netværk

PC, TV og FjordFlix-server skal kunne nå hinanden. TVet skal bruge serveradressen,
ikke `localhost` eller PC-forhåndsvisningens adresse. På dit lokale netværk er
serveren `http://192.168.1.110:8097`.

Kontrollér på PC, at `http://192.168.1.110:8097/tv-api/info` returnerer
`"app":"fjordflix-tv"`. Log ind på den normale FjordFlix-webside og kontrollér,
at film og bruger virker. TV-klienten genbruger serverens brugere, bibliotek,
favoritter og afspilningspositioner. Den kræver ingen særskilt TV-container.

Et offentligt HTTPS-domæne skal have et gyldigt certifikat, som TVet stoler på.
Til den første lokale test kan du bruge ovenstående HTTP-adresse og slå
"Login med HTTPS" fra i appen. Et privat `https://IP` med et selvsigneret
certifikat giver ofte forbindelsesfejl på TVet. Gæstenetværk/AP-isolation kan
også forhindre forbindelsen.

## 2. Installér Samsungs udviklingsværktøjer på PC

Installér [Tizen Studio med Samsung TV SDK](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html).
Åbn Package Manager og installér **Web CLI**, **Samsung TV Extension** og
**Samsung Certificate Extension**. Eksemplerne bruger standardmappen
`C:\tizen-studio`; vælg din egen placering, hvis den er anderledes.

Du skal have en Samsung Developer-konto til TV-certifikatet. FjordFlix-kontoen
og Samsung-kontoen har hver sin opgave.

## 3. Slå Developer Mode til på TVet

1. Find PCens lokale IPv4-adresse med `ipconfig` i Windows. Brug adressen for den
   aktive Wi-Fi-/Ethernetforbindelse på samme netværk som TVet.
2. Åbn **Apps** i Smart Hub. På nyere modeller skal du åbne **App Settings**.
3. Indtast **12345** hurtigt med fjernbetjeningen eller dens skærmtastatur.
4. Slå **Developer Mode** til. I feltet **Host PC IP** skriver du **PCens IP**.
5. Bekræft, og genstart TVet. Hold eventuelt tænd/sluk inde til Samsung-logoet
   vises, så det genstarter helt.
6. Kontrollér Developer Mode-markeringen i Apps efter genstart.

Samsung beskriver både den oprindelige og den nyere Apps-menu i
[TV Device-guiden](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html).

## 4. Forbind PC og TV

Find TVets IP under netværksstatus. Åbn **Tizen Studio → Tools → Device Manager →
Remote Device Manager**, tilføj TVets IP og port **26101**, og slå forbindelsen til.

Alternativt i PowerShell, med TVets egen IP i stedet for eksemplet:

```powershell
& 'C:\tizen-studio\tools\sdb.exe' connect 192.168.1.123
& 'C:\tizen-studio\tools\sdb.exe' devices
```

TVet skal stå som `device`. Hvis det er offline: kontrollér Host PC IP, fuld
genstart og netværksadgang. Tillad Device Manager/SDB i Windows Firewall på det
private netværk. TVet og serveren behøver ikke samme IP — de er forskellige enheder.

## 5. Opret et Samsung TV-certifikat

Åbn **Tools → Certificate Manager → + → Samsung → TV** og opret en profil,
fx **FjordFlixSamsung**. Opret eller genbrug dit author-certifikat, log ind med
Samsung-kontoen, og opret et distributor-certifikat med niveau **Public**.
Tilføj det tilsluttede TVs **DUID** i distributordelen. Afslut og vælg profilen.

I Device Manager højreklikker du det tilsluttede TV og vælger
**Permit to install applications**, hvis punktet findes. Brug samme
author-certifikat til senere opdateringer. Opbevar certifikatbackup og adgangskode
privat uden for NAS-projektet.

Se Samsungs [certifikatguide](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html)
og [CLI-forudsætninger](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/command-line-interface.html).

## 6. Byg, signér og installér

Åbn PowerShell i den eksporterede projektmappe:

```powershell
Set-Location 'Y:\fjordflix-SAMSUNG-APP'
npm ci
npm test
npm run package
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-and-install.ps1 -CertificateProfile FjordFlixSamsung -TvIp 192.168.1.123
```

Erstat TV-IP og eventuelt profilnavn. Kildeprojektet findes også under
`Y:\fjordflix\samsung`. Scriptet bruger din eksisterende certifikatprofil,
kontrollerer signaturfilerne, installerer pakken og starter appen. Det ændrer
ingen netværksindstillinger eller certifikater.

Den signerede pakke bliver `dist/FjordFlix-Samsung_0.1.0.wgt`. Filen med
`_UNSIGNED` i navnet er kun et byggeartefakt og kan ikke installeres direkte.
Samsung kræver en signeret WGT med TVets DUID; et generelt author-certifikat
alene er ikke nok.

Ved manuel brug af SDK: `tizen package -t wgt -s PROFIL -- APPMAPPE`, derefter
`tizen install -s SERIAL --name FIL.wgt -- PAKKEMAPPE` og
`tizen run -s SERIAL -p FjordFlix1.FjordFlix`. Find SERIAL med `sdb devices`.
Kommandoerne følger Samsungs [CLI-guide](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/command-line-interface.html).

## 7. Log ind og test

Åbn FjordFlix fra Apps. Indtast serveradressen, eller benyt telefonlogin, efter
at serveradressen er indtastet på TVet. Tryk OK på et tekstfelt for at åbne
tastaturet. Fjernbetjeningens pile flytter fokus, OK vælger, og Tilbage lukker
først menu/afspiller frem for hele appen.

Gennemgå følgende på TVet:

- **Forside:** Senest tilføjet står over Se videre. Kontrollér også Alle titler,
  søgning, Min liste og flere bibliotekssider.
- **Grundtest:** afspil en 1080p H.264/AAC-film, pause, fortsæt, spol og luk.
  Åbn filmen igen og kontrollér den gemte position.
- **Tekstundertekster:** vælg dansk, spol både frem og tilbage, og kontrollér
  timing og Fra-valget. Undertekster skal følge det valgte lyd-/videoforløb.
- **Serie:** gå til de sidste 10 sekunder, og kontrollér næste-afsnit-knappen
  og automatisk overgang. Pause må ikke fortsætte nedtællingen.
- **Trailer:** afspil og luk en trailer; filmens gemte position skal være bevaret.
- **Lyd:** prøv flere spor. DTS/TrueHD tilpasses serverens Samsung-kompatible
  lydvej, mens kompatibel video kan bevares.
- **4K/HDR10:** på et UHD/HDR-TV prøver du en kompatibel HEVC-fil og åbner
  Afspilningsdetaljer. Kontrollér faktisk output, farver, stabilitet og lydanlæg.
  På et FHD-TV skal Automatisk vælge en passende lavere vej.
- **Baggrund:** skift til en anden TV-app og tilbage. Filmen skal være pauset.
  Luk afspilleren og kontrollér, at serverens aktive stream bliver frigivet.

## Fejlfinding og teststatus

**Certifikat-/installationsfejl:** kontrollér Samsung-profilen, DUID, author-
certifikatet, Developer Mode og "Permit to install applications". Geninstallér
ikke med en ny identitet for hver build, hvis du vil bevare appdata.

**Sort skærm eller formatfejl:** prøv først Automatisk/1080p med H.264/AAC. Se
Afspilningsdetaljer og kontrollér serverens transkodning. Original lover ikke
konvertering af en inkompatibel kilde. HDR10 kræver det konkrete TVs støtte;
Dolby Vision er ikke en understøttet direkte Samsung-vej.

Appens udviklingsmål er 2018 og alle senere Tizen-årgange. Automatiske tests
kontrollerer ES5, fælles UI, fjernbetjeningshændelser og simuleret AVPlay inklusive
resume, undertekster og oprydning. **Der er endnu ikke udført en fysisk test på
dit Samsung-TV.** Hvert TVs decoder-/HDMI-egenskaber skal bekræftes på enheden.
Samsungs [2018-mediegrænser](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2018-tv-video-specifications.html)
beskriver bl.a., at DTS ikke understøttes fra denne årgang.
