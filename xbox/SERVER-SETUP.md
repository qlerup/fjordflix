# Aktivér TV-API på FjordFlix

TV-appen er selvstændig, men FjordFlix skal kunne udstede adgangstokens og levere video i et format, Xbox kan afspille.

## Serveropdatering til Xbox 0.1.9

**Opdatér både server og Xbox-app.** Den nye serverkode i søsterprojektet `fjordflix` tilføjer Xbox-profilen, HEVC med fMP4-segmenter og Full HD-grænsen for H.264-konvertering. Rettelserne er i `app/main.py` og `app/tv.py`; de er ikke installeret på den kørende server fra dette workspace.

Telefonlogin i 0.1.9 tilføjer også `app/tv_pairing.py` og de tre `app/static/tv-login.*`-filer.
Serveren opretter de nye login-tabeller automatisk. Den eksisterende `qrcode`-afhængighed
bruges til QR-billedet. Webadressen `/tv-login` og filerne under `/static/` skal nå samme
FjordFlix-server som `/tv-api/`; brug webdomænet, ikke et eventuelt separat videodomæne.

Udrul den opdaterede FjordFlix-kilde gennem installationens eksisterende bygge-/opdateringsproces. Bevar eksisterende Compose-projektnavn, miljøfil, GPU-konfiguration, netværk og datavolumener. Den integrerede TV-API følger med serverkoden. Hvis installationen stadig starter via den separate `fjordflix_tv.py` nedenfor, skal denne fil også opdateres, så den rapporterer serverens nye funktioner. Den separate fil alene giver ikke HEVC/fMP4-støtte.

Ved FjordHub skal ændringerne først være publiceret i det FjordFlix-repository, som Hub henter fra. Derefter kan **FjordFlix → Opdater** hente koden og genbygge containeren. Lokale, ikke-publicerede ændringer på denne PC kommer ikke med i en Hub-opdatering. Alternativt kan de gennemgåede serverfiler kopieres til den eksisterende installation og app-containeren genbygges der; brug installationens eksisterende Compose-konfiguration og overrides.

Kontrollér efter genstart, at `/tv-api/info` indeholder:

```json
{"app":"fjordflix-tv","version":1,"playback_profiles":["default","xbox"],"features":["xbox-hevc-fmp4","phone-login-v1","xbox-hdr10-base","xbox-hevc-transcode"]}
```

Et svar med kun `app` og `version` betyder, at den nødvendige opdatering ikke er aktiv. Appens Afspilningsdetaljer viser tilsvarende **Server Xbox/fMP4: klar** eller **serveropdatering mangler**.

## Ældre installationer: separat TV-login

Resten af denne vejledning handler om den separate token-udvidelse til ældre FjordFlix-installationer. Den tilføjer login, men erstatter ikke serveropdateringen ovenfor.

Dette trin udføres på den maskine, hvor **FjordFlix-serveren** kører. Xbox Device Portal på PC'en aktiverer ikke serverudvidelsen. Der er endnu ikke foretaget ændringer på en kørende installation.

## 1. Læg udvidelsen på serveren

Kopiér `fjordflix_tv.py` og `compose.tv.yaml` til en selvstændig mappe på serveren, fx `/opt/fjordflix-XBOX-APP`. Resten af appens kildekode, node_modules og APPX er ikke nødvendige på serveren.

## 2. Tilføj Compose-override

Brug **samme Compose-projektnavn, konfigurationsfiler og miljøfil som din eksisterende installation**. Tilføj `compose.tv.yaml` som sidste `-f`-fil. Det er vigtigt, så du genbruger dit eksisterende bibliotek og datavolumen.

For en almindelig Linux-installation, som normalt bruger `compose.yaml`, er mønstret:

```bash
cd /sti/til/fjordflix
export TV_APP_DIR=/opt/fjordflix-XBOX-APP
docker compose -f compose.yaml -f "$TV_APP_DIR/compose.tv.yaml" config --quiet
docker compose -f compose.yaml -f "$TV_APP_DIR/compose.tv.yaml" up -d --no-deps app
```

Har installationen også `compose.override.yaml`, skal den med **før** TV-override. Bruger du FjordHub, skal du bevare FjordHubs eksisterende `docker-compose.yml`, miljøfil, projektindstillinger og eventuelle GPU-override. Udskift ikke disse med standalone-eksemplet. Servercontaineren genstartes, så igangværende afspilning afbrydes.

På denne Windows-PC, hvis FjordFlix faktisk køres fra den lokale `compose.yaml` + `compose.override.yaml`, er den tilsvarende kommando fra FjordFlix-mappen:

```powershell
$env:TV_APP_DIR = (Resolve-Path '..\fjordflix-XBOX-APP').Path
docker compose -f compose.yaml -f compose.override.yaml -f '..\fjordflix-XBOX-APP\compose.tv.yaml' config --quiet
docker compose -f compose.yaml -f compose.override.yaml -f '..\fjordflix-XBOX-APP\compose.tv.yaml' up -d --no-deps app
```

Udvidelsen er monteret read-only i `/opt/fjordflix-tv`. Startkommandoen bliver `uvicorn fjordflix_tv:app`; FjordFlix' eksisterende startup, API og browserinterface bevares. Ingen serveradgangskoder skal skrives i TV-projektet.

## 3. Tjek API og netværk

Åbn denne adresse på PC'en med din faktiske serveradresse:

```text
https://film.ditdomæne.dk/tv-api/info
```

Et ældre svar er `{"app":"fjordflix-tv","version":1}`; for Xbox 0.1.9 skal `xbox-hevc-fmp4` også være annonceret som beskrevet ovenfor. Dette endpoint kræver ikke login og udleverer ikke biblioteket.

Ved lokal test kan adressen fx være `http://192.168.1.100:8096/tv-api/info`. TV'et skal kunne nå serverens LAN-IP og port. `localhost` på TV'et betyder TV'et selv. En serverport bundet til `127.0.0.1` kan ikke nås fra TV'et; brug din eksisterende LAN-opsætning/reverse proxy. En firewall skal tillade den relevante port på det betroede lokalnet.

Brug et gyldigt HTTPS-certifikat ved domæneadgang. Selvsignerede certifikater kan blive afvist på TV'et. En reverse proxy skal videresende `/tv-api/*` til FjordFlix uden ekstra browserbaserede login-sider og bevare Authorization-headeren.

## 4. Hvis du bruger et separat mediedomæne

Er `MEDIA_PUBLIC_URL` sat, fortsætter appen med at hente video fra dette domæne. Det skal nu også videresende **`/tv-media/*`** til samme FjordFlix-server. Tilføj fx følgende blok til dit eksisterende Caddy-site ved siden af `/media/*`:

```caddyfile
handle /tv-media/* {
    reverse_proxy {$MEDIA_UPSTREAM}
}
```

Undlad adgangslog på disse stier: URL'erne indeholder midlertidige videobilletter. Mediedomænet skal fortsat gå direkte til serveren uden Cloudflare-proxy. Hvis du kun bruger én lokal serveradresse og ikke har `MEDIA_PUBLIC_URL`, behøver du ikke et ekstra mediedomæne.

## Opdatering og tilbageførsel

Ved senere genoprettelse/opdatering af servercontaineren skal TV-override stadig medtages. Et automatisk FjordHub-redeploy, som kun bruger sin oprindelige konfiguration, kan ellers slå udvidelsen fra igen.

For at fjerne udvidelsen: genopret `app` med præcis den oprindelige Compose-kommando uden TV-override. Film, brugere og eksisterende browserlogin berøres ikke. TV-appen kan herefter ikke logge ind, før API-udvidelsen aktiveres igen.
