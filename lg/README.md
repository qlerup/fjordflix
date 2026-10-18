# FjordFlix for LG webOS

The LG client lives in `fjordflix/lg` alongside Windows/Xbox. Its build imports the shared TV UI from `xbox/tv`, while retaining Magic Remote navigation, the webOS manifest and device-format checks through `webOS.deviceInfo`. Source version: **0.1.11**.

## Features

- A shared Forside with Senest tilføjet above Se videre; all titles remain searchable and paginated.

- Library, tracks, subtitle selection, server-prepared trailers and explained playback plans.
- QR-assisted phone login after entering the server address on TV.
- A final-ten-second next-episode countdown. OK/click starts immediately; otherwise the next existing episode starts at completion, including across seasons. Pause/buffering stops the countdown.
- Stable seek position and server-generated still previews; late preview responses are ignored. Update server/client together.
- Diagnostics show buffer, dropped frames and server conversion speed. Compatible video remains unchanged when a different container/audio path is attempted.
- Original quality does not silently fall back to video transcoding.
- Authorized regular users can submit and follow media wishes; administrators cannot submit wishes.
- Shared first-login email/password completion through the server's TV login API.

The Xbox local-phone Windows service and Windows mpv are not installed on LG. HDR/Dolby Vision/audio depend on TV model, source profile and device tests. Xbox TrueHD/DTS preservation is not an LG compatibility promise. Browser profiles do not replace webOS policies.

## Install

Update the server; TV APIs, phone login and trailers are bundled, so the former `compose.tv.yaml`/`fjordflix_tv.py` extension is unnecessary. Install the generated IPK, e.g. `dist/dk.fjordflix.tv_0.1.11_all.ipk`, through Developer Mode/webOS Studio. `dist/app` is the assembled Studio project. See [the LG test guide](TEST-PAA-LG-TV.md), which currently remains in Danish.

The TV uses bearer login and scoped media tickets. Central Hub account requirements still apply: if an active client cannot show a newly required email-update form, complete it in the updated web app/Hub before resuming TV use.

## Build and test

```sh
npm ci
npm test
npm run build
npm run test:browser
npm run test:next
npm run package
```

Scripts are checked for ES5 compatibility. Browser/API tests use fixtures; these results do not claim a physical LG-TV test for every update. See the [server README](../README.md) for media/proxy prerequisites.
