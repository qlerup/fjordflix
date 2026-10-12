# FjordFlix på pc

Dobbeltklik på **FjordFlix TV - PC Simulator** på skrivebordet eller på
`START-PC-SIMULATOR.cmd` i denne mappe. Genvejen bygger den aktuelle lokale
app og åbner den i LG webOS 6.0 Simulator. Den installerer eller starter
ikke noget på det fysiske TV.

Log ind med `film.gleruphub.dk`, slå **Login med HTTPS** til, og brug dit
normale FjordFlix-login. Simulatoren har sin egen login-session.

Brug musen eller simulatorens fjernbetjening til at navigere. Piletaster
og Enter kan bruges til at vælge. Brug fjernbetjeningens Back til at gå tilbage.

Efter kodeændringer køres genvejen igen for at bygge den aktuelle app.
Simulatoren kan genindlæse ændringer i den byggede `dist/app`-mappe.

Simulatoren er til test af brugerflade, login og navigation. Dens video-
og lydformater er ikke identiske med LG G1. HDR, Dolby Vision, Atmos og
endelig Direct Play-kompatibilitet skal testes på TV'et, når det er ledigt.

Simulator: `%LOCALAPPDATA%\FjordFlix-TV-Simulator`

LG-dokumentation: https://webostv.developer.lge.com/develop/tools/simulator-introduction
