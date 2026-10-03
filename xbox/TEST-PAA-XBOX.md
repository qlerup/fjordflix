# Send FjordFlix direkte til Xbox

Du behøver ikke publicere appen til Microsoft Store. Installationen sker fra PC'en
til Xbox via Xbox Device Portal. PC og Xbox skal kunne nå hinanden på lokalnettet.

## 1. Aktivér Developer Mode

1. Installér **Xbox Dev Mode** fra Store på Xbox.
2. Åbn den, og følg aktiveringen med en Microsoft Partner Center-udviklerkonto.
   Kontoen skal være fuldt registreret; se [Microsofts aktiveringsguide](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/devkit-activation).
3. Vælg **Switch and restart**. Xbox starter derefter i **Dev Home**.

Developer Mode er adskilt fra almindelig spiltilstand. Når du vil spille almindelige
Xbox-spil igen, vælger du **Leave Dev Mode**, og konsollen genstarter.
Hvis der vises en mulighed for at slette sideloadede apps ved skiftet, skal du undlade
at vælge den, hvis du vil bevare FjordFlix og dens gemte serverforbindelse.

## 2. Åbn forbindelsen fra PC

1. I Xbox' **Dev Home**: gå til **Remote Access → Remote Access Settings**.
2. Slå **Enable Xbox Device Portal** til, og angiv brugernavn/adgangskode til portalen.
   Det er et separat login fra din FjordFlix-bruger.
3. Notér den præcise URL, der vises under **Remote Access**.
4. Åbn den i Edge på PC'en, fx `https://192.168.1.50:11443`.
   Brug adressen på din Xbox; eksemplet er ikke din konsols adresse.
5. Ved konsollens certifikatadvarsel kan du fortsætte til din egen konsols lokale
   adresse som beskrevet i [Microsofts Device Portal-guide](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/device-portal-xbox).
   Log ind med portalens brugernavn/adgangskode.

## 3. Upload installationsfilen

1. Åbn **Home / My games & apps** i Device Portal.
2. Vælg **Add**, eller værktøjet til at installere en app-pakke. Navnet kan variere
   med Xbox-systemversionen.
3. Vælg filen **`dist/FjordFlix-Xbox_0.1.8.appx`** fra denne projektmappe.
4. Fortsæt og installér. Pakken har ingen separate framework-afhængigheder.
   Hvis værktøjet specifikt beder om udgivercertifikatet, er den offentlige fil
   **`dist/FjordFlix-Xbox.cer`**. Den er ikke en app-afhængighed.
5. Start **FjordFlix** fra Dev Home eller portalens **Launch**-handling.

Ved signaturfejl: kontrollér, at Xbox faktisk er i Developer Mode, at du bruger den
signerede `.appx` frem for `dist/app`, og at konsollens dato/tid er korrekt.
Gem den konkrete fejlkode fra Device Portal, hvis installationen fortsat fejler.

## 4. Log ind og afprøv

Vælg **Log ind via telefonen** efter at have indtastet serveradressen. Scan QR-koden
med telefonens kamera, kontrollér at koden matcher TV'et, og skriv dit normale login
på mobilen. Efter **Log ind på Xbox** åbnes biblioteket automatisk på Xbox.
Hvis du bruger en lokal IP-adresse, skal telefonen kunne nå samme lokalnet.
Prøv også B/Tilbage, udløbet kode og **Lav en ny QR-kode**. En gammel eller annulleret
kode må ikke logge appen ind. Hvis serveren mangler funktionen, vises en forklaring,
og almindeligt login nedenfor kan stadig bruges.

1. Skriv samme serveradresse som i LG-appen, og log ind med din FjordFlix/FjordHub-bruger.
   A åbner et tekstfelt; A eller B afslutter redigering.
2. Opdatér også serveren som beskrevet i [SERVER-SETUP.md](SERVER-SETUP.md).
   Under Afspilningsdetaljer skal der stå **Server Xbox/fMP4: klar**.
3. Afprøv en almindelig 1080p H.264/AAC-film og en 4K HEVC-film. Kontrollér,
   at planen viser Direct Play eller Direct Stream og filmens originale opløsning
   ved Original/4K. Start med undertekster Fra eller et tekstspor. Prøv derefter
   en HEVC MKV-film med lydkonvertering, hvor videoen skal bevares som Direct Stream.
   Ved fejl: åbn Afspilningsdetaljer og gem oplysningerne. Original må ikke starte
   videokonvertering; Automatisk må bruge højst Full HD ved nødvendig konvertering.
4. Kontrollér D-pad/stick, A/B, X, LB/RB, søgning, favoritter og lyd/undertekster.
5. Luk afspilleren og åbn filmen igen for at kontrollere gemt position.
6. Skjul appen under afspilning og kontrollér, at den pauser.
7. Test Log ud og genåbning af appen.

Original video kan være 4K; H.264-konvertering begrænses til Full HD. Faktisk 4K/HDR-afspilning afhænger af
konsol og filformat. Den er bygget og testet på PC, men afspilning og Xbox'
skærmtastatur er endnu ikke verificeret på fysisk hardware.

## Senere opdatering

Upload en nyere signeret pakke med samme identitet og højere versionsnummer via
samme portal. Bevar udviklercertifikatet på bygge-PC'en, så pakkerne har samme udgiver.
Afinstallation kan bruges ved en ren test, men fjerner appens lokale forbindelsesdata.


## 0.1.10: alle loginoplysninger på telefonen

Installer `dist/FjordFlix-Xbox_0.1.10.appx`. Lad serverfeltet være tomt, og vælg
Log ind via telefonen. Scan den lokale QR-kode, og skriv serveradresse,
brugernavn og adgangskode på telefonen. Der kræves ikke en ny serveropdatering
for dette login, hvis normalt TV-login allerede virker.

Kontrollér, at telefon og Xbox er på samme lokalnetværk. Telefonen skal kunne
kontakte den IP og port, som står på Xboxen. Efter korrekt login skal biblioteket
åbne på Xbox, telefonen vise succes og den midlertidige adresse holde op med at svare.
Prøv også forkert adgangskode, Tilbage til login og udløb efter fem minutter.

### 4K og Dolby Vision fra 0.1.9

Opdater serveren via FjordHub for 4K-funktionerne. Afspilningsdetaljer viser Dolby
Vision-profil og HDR10-basislag. Profil 7 og profil 8 med kompatibilitets-ID 1 kan
remuxes uden videogenkodning til HDR10. Andre/ukendte Dolby Vision-profiler stoppes
med forklaring i 4K-forløbet. Ældre filmmetadata opdateres i baggrunden efter serverstart.

Original bevarer videoen. Automatisk/4K bruger kompatibel original eller HEVC/fMP4
med bevaret 4K-opløsning ved nødvendig videokonvertering. Den konvertering giver SDR.
Serveren afprøver HEVC NVENC og bruger ellers libx265 på CPU; CPU-kodning kan være
langsommere end realtid. Se encoder, Serverhastighed, Buffer og Tabte billeder efter
30–60 sekunders afspilning. Tryk Stop og åbn Afspilningsdetaljer; målingerne bevares.
Rigtig 4K-konvertering og uændrede dekodede billeder efter HDR10-remux er testet lokalt;
flydende afspilning på fysisk Xbox er ikke hardwareverificeret.
## 0.1.11: TrueHD/Atmos og DTS

Opdater serveren og installer `dist/FjordFlix-Xbox_0.1.11.appx`.
Afspil samme film og lydspor som i Plex med kvalitet **Original**, først uden
undertekster. Kontrollér, at afspilningsdetaljer viser original TRUEHD og otte
kanaler for et 7.1-spor, og at soundbaren faktisk viser Dolby Atmos.
Gentag med tekstundertekster og spoling frem/tilbage. Kontrollér også stop,
genstart og skift til filmens AC-3-spor. Serverens markering af original lyd er
ikke i sig selv dokumentation for HDMI-passthrough.
