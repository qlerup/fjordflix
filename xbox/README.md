# FjordFlix for Xbox

A standalone JavaScript/UWP TV client for Xbox One, One S, One X, Series S and Series X with current system software. Xbox 360/original Xbox are unsupported. Uses the shared TV UI and server token API. Source version: **0.1.17**.

Start with [the console test guide](TEST-PAA-XBOX.md). That separate guide currently remains in Danish.

## Features

- Server/login, movies/series, search, pagination, favorites and resume progress.
- Audio/text-subtitle/quality selection and diagnostic playback plans.
- Server-prepared H.264/AAC trailers without changing movie progress.
- Stable seek position and preview until ready, discarding late images. Update server/client together for the seek-preview API.
- Click/A/OK starts the next episode immediately in the final ten seconds; otherwise it starts at the end. Pause/buffering stops the countdown. Existing episodes are selected in season/episode order, including across seasons; films/last episodes have no next button.
- Permitted regular users can submit/follow wishes. Administrators review centrally and cannot submit wishes.
- First-login required email/password fields, direct login and phone-assisted login.

## Installation artifacts

`npm run package` produces a Developer Mode APPX, e.g. `dist/FjordFlix-Xbox_0.1.17.appx`, public `dist/FjordFlix-Xbox.cer`, `dist/SHA256SUMS.txt` and packaged `dist/app/`. Use the generated version filename rather than an older README release name.

The architecture-neutral package uses Xbox's JavaScript/UWP runtime without external frameworks, LG tools, Visual Studio or WebView2 installation on the console. It is not a Store release. Signing identity is `FjordFlix.Xbox`, publisher `CN=FjordFlix Development`.

## Login from a phone

On a physical Xbox, choose Phone login even with empty server fields. The app opens a temporary HTTP page on the console's LAN IPv4 and a selected port. Scan the QR code and enter server address/credentials on the phone. Domains, full HTTP(S) origins and private IP/port addresses are accepted.

Both devices must share a reachable LAN; guest-network isolation prevents access. The random one-use page closes on success, cancellation, suspension or after five minutes. It forwards to the server's ordinary TV login, stores no password and requires only a working compatible TV-login API. The app retains server address/token; logout revokes the token, which normally lasts seven days.

The earlier server-based QR pairing is retained for the browser simulator. It needs `phone-login-v1`, `/tv-login`, `/static/*`, `tv_pairing.py` and the updated server. That code contains an approval secret, not a password/token; the polling device secret stays in memory, database entries store hashes, and approval is single-use. The phone never receives the Xbox token.

## Navigation

D-pad/left stick navigates; A selects/opens the system keyboard; B returns/cancels; X/Menu pauses; LB/RB skips 30 seconds; Y focuses search. System media buttons/media remotes are connected. Hiding the app pauses playback; UWP suspension attempts to save progress/release resources within its short time budget.

## Playback and diagnostics

The client tests actual decoder support. Compatible HEVC/MP4 and VP9/WebM can play directly, including 4K where supported. MKV/incompatible audio can use remux with unchanged HEVC. HLS/fMP4 requires `xbox-hevc-fmp4` from `/tv-api/info`; login alone does not prove that feature.

Original forbids silent video transcoding. Auto/4K can use confirmed HEVC-output transcoding up to 3840 × 2160 when the client/server support it; H.264 fallback is capped at 1920 × 1080 and 8 Mbit/s, and HEVC at 25 Mbit/s. An incompatible requested 4K plan without a usable HEVC path stops with a reason. Manual lower qualities remain available. See [server setup](SERVER-SETUP.md) and the [server README](../README.md).

A verified Dolby Vision profile 7/compatible profile 8 HDR10 base may be copied while removing DV RPU/enhancement metadata; unknown profiles are not assumed compatible. Transcoded HDR becomes SDR. Image subtitles require burn-in and may prevent original-video preservation. A library 4K badge describes the source, not actual output.

The `xbox-matroska-audio` server capability supports original selected TrueHD/DTS through Matroska with compatible HEVC/HDR10. It streams without creating a complete temporary movie; seek restarts at the desired position. Errors do not silently replace original audio with stereo. Delivered codec/channels confirm the server stream, not the HDMI signal; verify the receiver with Xbox Allow passthrough enabled. Dolby Vision/Atmos and every physical console/output chain are not guaranteed.

Diagnostics include source/decoder/server plan, recent errors, buffer, dropped frames and conversion speed. Source-preservation/fallback tests and signed APPX checks do not prove hardware decoder/output behavior. Physical Xbox keyboard, native playback, standby, inbound phone page and HDMI still need console testing.

## Server and proxy

Use built-in `/tv-api` and scoped `/tv-media` tickets, with bearer authentication rather than browser cookies. Public media proxies must forward the TV media route and avoid logging tickets. Current Hub membership/central requirements remain server-enforced; complete any required account email update in the updated web app/Hub if the active TV client cannot present that flow. The native decoder policy remains independent of browser profiles.

## Build and test

```powershell
npm ci
npm run build
npm test
npm run test:browser
npm run test:phone
npm run test:next
npm run package
```

Packaging obtains Microsoft SDK tools from official NuGet if absent. A reusable self-signed certificate is created in the current user's personal store, not installed as a trusted root. Keep `.signing/`, private keys and `.tools/` out of shared source.

Phone fixtures use the server repository/Python environment or `FJORDFLIX_TEST_PYTHON`, temporary users, actual QR decoding and a separate browser. WinRT sockets are simulated through real Node TCP/HTTP; physical-console firewall behavior is not claimed.

References: [Developer Mode](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/devkit-activation), [Device Portal](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/device-portal-xbox), [UWP manifest](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-f-application), [Xbox media formats](https://learn.microsoft.com/en-us/windows/uwp/apps-for-xbox/supported-technologies).
