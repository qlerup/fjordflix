# FjordFlix for Windows

Native original-file playback for Windows 10/11 x64, with the server's library UI and a bundled mpv player. Source package version: 0.1.19; generated releases may have a newer automatically assigned version.

## Install and play

Install `FjordFlix-Setup.exe`, enter the server's HTTP(S) address and sign in. The server must expose the compatible desktop API. No separate mpv installation or administrator rights are required. The unsigned installer may trigger Windows SmartScreen.

Library/settings load from the server. Original media opens in a native mpv window with local hardware decoding when supported; **desktop mode does not request server video transcoding**. HDR depends on Windows, display, GPU driver and source profile. Browser profiles do not replace this native playback configuration.

The library/player start fullscreen. F11 toggles library fullscreen, F toggles player fullscreen and Alt+F4 closes the window. Native window dragging is disabled so pointer gestures operate controls/timeline/volume.

## Controls, seeking and series

- Choose audio/subtitles on the detail page or while playing.
- Space pauses; Left/Right skip ten seconds; F toggles fullscreen; J cycles subtitles; `#` cycles audio; Q returns to the library.
- A/S opens audio/subtitles. Tab/Enter operate buttons; Up/Down and the wheel navigate long track lists. Escape closes the menu, exits fullscreen or returns to the library.
- Controls hide while playing and appear on pointer movement/pause. Position saves every 15 seconds and on close.
- Seeking preserves the selected timeline position while preparing and displays a local mpv-decoded still preview. Late images from an older seek or resumed playback are ignored.
- The final ten seconds of an episode show a clickable next-episode countdown; it follows playback/pause and starts the next existing episode, including across seasons.
- Change the server through the menu while idle. Both web and any separate media origin must be reachable.

## Audio

Dolby Digital, Dolby Digital Plus, TrueHD and DTS/DTS-HD attempt original WASAPI passthrough to the selected Windows output. Atmos/DTS:X data can remain only when the HDMI/audio chain supports the original format. Select the intended HDMI output in Windows.

If WASAPI fails to open that output, the app tries one local PCM decode while preserving video, position, pause and subtitles. A second failure shows an error. PCM is not Atmos passthrough; the server does not transcode desktop audio. Packet/fallback tests are not a physical Atmos-receiver verification.

## Accounts and wishes

The server handles login through HttpOnly cookies in the Electron session; only the server address is stored by desktop code. Shared Hub onboarding and required-email prompts use the updated server UI. Administrators review/reply to wishes but cannot submit them; permitted regular users can submit and follow their own wishes. Update the server for these UI changes without replacing the native player.

## Playback diagnostics

Use the app menu's Save playback diagnostics while a problem occurs. The report includes app version, title, start position, buffering/seeking state and recent mpv warnings, hiding media origins/tickets. Playback failures also save `playback-diagnostics.json` in the local user profile. Reports are never sent automatically. Errors show the actual open/playback failure.

The updated server receives playback status, position and selected tracks for Settings → Active streams.

## Build and test

On Windows with Node.js and PowerShell:

```powershell
cd desktop
npm ci
./prepare.ps1
npm test
npm run dist
```

`prepare.ps1` downloads the pinned official mpv build and verifies SHA-256. Output includes `desktop/dist/FjordFlix-Setup.exe`, `.blockmap` and `latest.yml`. Sources/licenses are in `THIRD-PARTY.txt` and bundled notices.

`node smoke.cjs`, with Playwright on `NODE_PATH`, uses temporary database/profile/audio fixtures for login, native HTTP playback and saved position; it does not prove 4K/HDR hardware or clean-machine installation.

For WASAPI regression, set `FFMPEG` to `ffmpeg.exe` and `FJORDFLIX_TEST_WASAPI=1`, then run `node --test desktop/tests/audio-fallback.cjs` from the server repository root. It requires an output rejecting generated silent TrueHD passthrough and checks continued PCM playback without video reload. Normal tests need no physical output.

For subtitles, run `node desktop/test-subtitle-switch.cjs <ffmpeg.exe> [supsample.mkv]` from the root. The optional [PGS fixture](https://samples.ffmpeg.org/sub/PGS/supsample.mkv) is not committed. Generated MKV tests cover visible PGS/text switching, pause and position. MKV subtitles use up to ten seconds of preroll to recover display state before a keyframe, which can increase seek reads.

## Security and updates

The renderer is sandboxed without Node.js. Native IPC is restricted to the main window on the selected server. Pages pass only movie IDs, position and track indices, never arbitrary process arguments/paths. mpv ignores user config/scripts and loads only bundled `player.lua`. Short-lived movie/login-scoped tickets renew during playback and revoke on exit.

Check for updates in the menu/topbar uses public GitHub Releases via electron-updater. Only newer stable versions are offered. Download/install require separate confirmation; active playback blocks installation. Download SHA-512 is checked against the release manifest, but installers remain unsigned. Version 0.1.0 needs one manual upgrade.

## Publishing

The desktop workflow tests/builds changes under `desktop/` and publishes installer, blockmap and `latest.yml`. Version assignment increments the highest release unless `package.json` already declares a higher version; package/lock receive the same build version. Releases serialize and tags point to the built commit. Manual workflow dispatch is also supported. Server-web-only changes do not require a native release because the UI loads from the server.
