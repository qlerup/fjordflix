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
- Upload med fremdrift, filkontrol, diskpladskontrol og grænse på 100 GB pr. film.
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
- Første lydspor vælges automatisk og konverteres til stereo AAC i HLS. Undertekstvalg, flere lydspor, folder-scanning, metadata fra filmdatabaser, sletning/redigering af film, adgangskodeskift og native TV-apps er ikke med endnu.
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

### Teknisk grundlag

Python/FastAPI, SQLite med WAL, FFmpeg/FFprobe og en lokal kopi af HLS.js. Ingen eksterne webtjenester er nødvendige under brug. Afspilning bruger FFmpegs [HLS-muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2).
