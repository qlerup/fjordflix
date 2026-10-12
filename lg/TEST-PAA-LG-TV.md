# Test FjordFlix på dit LG-TV med webOS Studio

Du har allerede installeret webOS Studio. Følg nedenstående på din PC og dit LG G1. Den samme fremgangsmåde er beregnet til andre LG-TV'er med webOS 3.0 eller nyere.

## 1. Gør FjordFlix-serveren klar

Opdatér FjordFlix-serveren; TV-API'et er nu indbygget. Brug ikke den gamle serverudvidelse. Åbn `DIN-SERVER/tv-api/info` i PC'ens browser, og kontrollér at svaret indeholder `"app":"fjordflix-tv"` og `"version":1`.

Du skal have en eksisterende FjordFlix-bruger — eller FjordHub-bruger, hvis serveren administreres derfra. Opret bruger og upload film fra den normale FjordFlix-webside. TV-appen bruges til at se biblioteket og afspille.

## 2. Aktivér Developer Mode på TV'et

1. Forbind TV og PC til samme netværk.
2. Opret/log ind på din [LG Developer-konto](https://webostv.developer.lge.com/).
3. Find **Developer Mode** i TV'ets appbutik, og installér LG's app.
4. Åbn den og log ind med LG-kontoen.
5. Slå **Dev Mode Status** til. TV'et genstarter.
6. Åbn Developer Mode igen, og slå **Key Server** til.
7. Notér TV'ets IP-adresse og den viste passphrase. LG-kontoen bruges kun til udviklertilstand; den er forskellig fra dit FjordFlix-login.

Disse trin følger [LG's Developer Mode-vejledning](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app).

## 3. Forbind webOS Studio

1. Åbn VS Code med webOS Studio.
2. Vælg **File → Open Folder**, og åbn `fjordflix-LG-APP`.
3. Åbn kommandopaletten med **Ctrl+Shift+P**, kør **webOS: Set Device Profile**, og vælg **tv**.
4. Hvis Studio efterspørger værktøjer, kør **webOS: Install Global Packages**.
5. Kør **webOS: Set Up Device → Add Device**. Brug:

   | Felt | Værdi |
   |---|---|
   | Navn | `lg-g1` |
   | IP | TV'ets IP fra Developer Mode |
   | Port | `9922` |
   | Bruger | `prisoner` |

6. Kør **webOS TV: Set Up SSH Key**, vælg `lg-g1`, og indtast passphrasen præcis som på TV'et.
7. Find TV'et under **KNOWN DEVICE**, og vælg det som standardenhed.

TV'ets IP bruges her til installation. **Serverens IP** skal først bruges inde i FjordFlix-appen.

## 4. Installér og start appen

Den færdige fil ligger her:

```text
fjordflix-LG-APP/dist/dk.fjordflix.tv_0.1.7_all.ipk
```

I Studio: importér **`dist/app`** via importknappen i **APPS IN WORKSPACE**. Vælg **Run App** på FjordFlix og vælg dit TV. Studio pakker, installerer og starter projektet. Importér ikke kildemappen `app` alene.

Alternativt kan du installere den allerede pakkede fil fra VS Code-terminalen i `fjordflix-LG-APP`:

```powershell
npx ares-install --device lg-g1 .\dist\dk.fjordflix.tv_0.1.7_all.ipk
npx ares-launch --device lg-g1 dk.fjordflix.tv
```

Navnet `lg-g1` skal svare til det navn, du valgte i Studio. Se [LG's webOS Studio-guide](https://webostv.developer.lge.com/develop/tools/webos-studio-dev-guide) for import, forbindelse og Run App.

## 5. Log ind i FjordFlix på TV'et

1. Indtast FjordFlix-serverens adresse, fx `https://film.ditdomæne.dk` eller lokalt `http://192.168.1.100:8096`.
2. Indtast dit FjordFlix-/FjordHub-brugernavn og adgangskode.
3. Vælg **Log ind**.
4. Biblioteket kommer fra netop denne server. Appen husker server og adgangstoken, så du normalt ikke skal logge ind hver gang. Et udløbet token kræver nyt login.

Domæner får HTTPS som standard. Private IPv4-adresser får HTTP, hvis du udelader protokollen. Brug serverens faktiske port — port 9922 er kun til udviklerforbindelsen til TV'et.

## 6. Afprøv disse ting

- Brug **piletaster + OK** til at åbne film. Afprøv også Magic Remote-markøren.
- Søg efter en film, brug Min liste, og skift mellem sider ved et større bibliotek.
- Lad kvalitet stå på **Automatisk**. Afspilleren viser Direct Play, Direct Stream eller Transcoding.
- Test først en almindelig H.264/AAC-MP4. Prøv derefter en MKV/anden codec og manuelt 720p, så konvertering også bliver afprøvet.
- Pause, fortsæt, spol 30 sekunder og gå tilbage. Åbn filmen igen og kontrollér, at positionen er gemt.
- Tryk Tilbage i detaljer for at komme til biblioteket. Tilbage fra biblioteket spørger, om appen skal lukkes.
- Luk helt og genåbn; kontrollér husket login. Test derefter Log ud og Skift server.

Test på det fysiske TV er nødvendigt. Browsertesten på PC'en beviser navigation og API-flow, men ikke TV'ets hardwaredekodning. Ved en fejl er TV-model/webOS-version, filmens codec og afspillerens viste tilstand nyttige oplysninger.

## Fejlfinding

| Problem | Tjek |
|---|---|
| TV-API mangler | Åbn `/tv-api/info`. Genstart serveren med TV-override. |
| Ingen forbindelse | Server-IP/port, firewall, samme netværk og certifikat. Brug ikke localhost på TV'et. |
| Forkert login | Afprøv samme bruger på FjordFlix-websiden. FjordHub kan kræve skift af midlertidig adgangskode dér først. |
| Bibliotek ses, men video fejler | Prøv 720p. Kontrollér FFmpeg på serveren og `/tv-media/*` på eventuelt mediedomæne. |
| Studio kan ikke forbinde | Key Server skal være tændt; hent SSH-nøglen igen med den aktuelle passphrase. |
| Appen forsvinder efter en periode | Developer Mode kan være udløbet. Aktivér igen og geninstallér appen. |

Til logning kan du bruge Studios debugfunktion eller køre `npx ares-inspect --device lg-g1 --app dk.fjordflix.tv`. Del ikke adgangstokens eller hele videobillet-URL'er fra netværksloggen.

Hold øje med **Remain Session** i Developer Mode, og brug **EXTEND**, før tiden løber ud. LG beskriver, at apps installeret via udviklertilstand fjernes, når Developer Mode bliver deaktiveret. Denne installationsmetode er til udvikling/test; appen er ikke udgivet i LG's appbutik. Se [LG's forklaring af udløb](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app).
