# FjordFlix

A private media server with a cinema-style library, movies/series, per-user progress, browser playback, real FFmpeg transcoding and Windows/LG/Xbox/Samsung clients. The interface currently uses Danish labels. [Artwork](app/static/logos/README_logo.md) and [brand provenance](branding/README.md) are included.

## Features

FjordSeed's **Streaming → Find FjordFlix** can use an existing indexed library
folder as its download destination on the same Docker host. The authenticated
`GET /api/hub/seed-library` endpoint lists those folders; Seed maps the existing
Flix bind mount back to its host directory and checks write access before
mounting it. This does not change Flix sources or mounts. Update both apps.

- Upload/import MP4, MKV, MOV, WebM, M4V, AVI and TS; inspect codecs, resolution, bitrate, HDR and audio.
- Search, Home/Movies/Series, My list and Continue watching per user; season/episode grouping and next-episode navigation.
- TMDB posters, backgrounds, cast and localized metadata, manual matching/editing and custom images.
- Multiple audio tracks, extracted streaming text subtitles, image-subtitle burn-in and SubDL/OpenSubtitles downloads.
- Direct Play, Direct Stream/remux and CPU/NVIDIA transcoding with source-aware quality and diagnostics.
- Independent browser profiles, capability negotiation, compatible 4K/HDR preservation and bounded HLS buffers.
- Optional separate direct-video origin, AirPlay, phone remote, native Windows playback and TV-token APIs.
- User media wishes with administrator replies/statuses and locally assigned submission permission.
- Shared FjordHub login/SSO, first-login email/password setup and required email updates for active sessions.

## First installation

Docker must run Linux containers. The standalone `compose.yaml` requests NVIDIA (`gpus: all`); remove that request on a host without a usable NVIDIA GPU for CPU operation.

```sh
docker compose up -d --build
```

Open `http://localhost:8096` and create the first administrator. There is no default password; setup locks atomically after creation. Upload a film or add library folders. Try Original for supported direct playback, or a lower quality to exercise transcoding; the player shows actual method/output/encoder.

Standalone administrators can issue single-use invitations valid for seven days. Hub-managed accounts are administered centrally rather than through local registration/invitations. Media is available to authorized users of the installation.

## FjordHub deployment and accounts

The Hub default port is **8097**, avoiding Parcel's 8096. Existing configured ports are not silently changed. Standalone uses `compose.yaml` and its existing volume; Hub explicitly selects `docker-compose.yml`, separate media/data directories and optional GPU overrides/device mapping. `host.docker.internal` provides Hub connectivity on Linux/Docker Desktop. Use different ports for parallel installations.

Opening through Hub uses single-use SSO; direct login uses the shared account. Users confirm email and replace temporary passwords inside the app when required. Existing sessions are checked with a short membership cache; removed access blocks new media requests and invalidates sessions. Hub outages block protected requests after cache expiry; bytes already transferred cannot be withdrawn.

Hub administrators can select **Require email update on next opening**. Opening or returning to an updated browser app checks existing logins and presents a non-dismissible email form. Save a valid, unique address to clear the shared requirement across updated apps; confirming an existing valid address is allowed. Password/session identity is retained. Update Hub and Flix together.

Matching local/Hub names do not automatically merge identities or migrate solo history. Film files/history are not deleted by switching authentication, but moving old history is a separate task.

### Media wishes

Administrators enable Can submit wishes for individual regular users under Settings → Users. Enabled users submit movie/series wishes with notes and follow their own replies/statuses. Administrators see all wishes, reply and set Received/Fulfilled/Declined, but **cannot submit wishes themselves**; this is also enforced by the server. The web/Windows admin view omits the submission form.

Permission is local to Flix, including for Hub identities. Each user can have at most 20 unanswered wishes; duplicate open wishes from that user are rejected. Requests/permissions persist in the database. LG 0.1.11, Xbox 0.1.18 and Samsung 0.1.0 support submission/listing; update server/clients and reopen after permission changes.

## Library folders and storage

Under Settings → Library → Add folder, select existing drives/subfolders. Sources scan recursively at startup, every 15 minutes and with Scan all folders. Results report new/updated titles and read errors. Overlapping roots are rejected, symlinks are not followed, and both `.incomplete` and the previous `.fjordseed-buffer` are excluded so unfinished downloads are not indexed.

Hub's Proxmox disks/storage inventory includes pools, physical disks/partitions and visible LXC mounts. Required audit permissions are `Datastore.Audit`, `Sys.Audit` and `VM.Audit`; the inventory itself neither formats nor mounts disks. A pool marked mounted does not prove it is readable inside the app. UUID disk mounts are not guessed from device names.

Hub Compose mounts host `/mnt` read-only at `/library/server`. Set `LIBRARY_HOST_ROOT` if existing LXC mounts use another root, and recreate the container after mount changes. Only mounted/readable folders can be browsed. For standalone additional sources, copy `compose.library.example.yaml` to `compose.library.yaml`, edit existing host paths and run:

```sh
docker compose -f compose.yaml -f compose.library.yaml up -d --build
```

Include the equivalent override explicitly for a Hub install and preserve it across updates. `LIBRARY_ROOTS` is a JSON list of permitted absolute **container** roots, default `["/library"]`. Proxmox storage must first be mounted in the Docker VM/LXC; see [bind mounts](https://github.com/proxmox/pve-docs/blob/master/pct.adoc).

External videos are read in place, never copied into upload storage. `DATA_DIR` retains database, covers, subtitle cache and temporary streams. Removing a source removes its index/favorites/history but never original files. Individual external titles cannot use permanent file deletion. Temporarily missing drives/files keep index/history until accessible again; changed files refresh technical data without discarding manual metadata.

## Uploads, series and metadata

Multi-file/drag-and-drop upload queues one file at a time with per-file progress/results and continues after failures. Requests are limited to **2 MiB each** to fit proxy request limits. The server reassembles without altering video; failed requests retry, and Retry resumes the saved offset while the same tab stays open. There is no fixed full-file size limit, but space checks apply. Closing the modal is safe; closing the tab interrupts the queue. Incomplete sessions expire after 48 hours and persist on disk; use the provided single-worker server deployment.

Drop a complete folder or choose **Vælg mappe** to import supported videos recursively. Folder uploads preserve their relative directories and video filenames beneath the configured upload storage; for example `The Show/Season 2/E01.mkv` retains its series/season context. Other file types are shown as skipped; folders containing no supported videos are not created. Existing files are never overwritten: a conflicting video filename receives a unique suffix. Regular individual file uploads retain their existing storage layout. Folder uploads use the same chunking, resume, indexing, TMDB and automatic subtitle-provider flow as ordinary uploads.

Name episodes like `The.Show.S02E10.1080p.mkv`, `The Show s02e10.mp4` or `The Show 2x10.mkv`; `S00E01` means a special. A start year distinguishes remakes. TMDB TV lookup supplies series/episode metadata and separate still images; absent metadata falls back to local grouping/video stills. Home groups series, Movies/Series filter, and seasons/episodes sort numerically. Next episode selects the next existing file, including across seasons. History is per file; favoriting an episode shows its series. Multi-episode files are not split automatically.

### TMDB

Save an API Read Access Token/API key in Settings → Movie data. The saved key overrides environment configuration and is never returned to the browser, but is stored **unencrypted in the local database**; protect data/backups. Removing it disables lookup even if an older environment default exists. Alternative initial configuration:

```dotenv
TMDB_READ_ACCESS_TOKEN=your_read_access_token
```

Recreate after environment changes; never commit credentials. TMDB terms/attribution apply: [API settings](https://www.themoviedb.org/settings/api), [FAQ](https://developer.themoviedb.org/docs/faq), [logo attribution](https://www.themoviedb.org/about/logos-attribution). Follow the required attribution/logo guidance before enabling the integration.

Danish descriptions are preferred, with English fallback. Metadata/images cache locally; file contents/technical data remain unchanged. Missing/ambiguous lookup or an outage does not prevent import. Existing uploads are not automatically rematched. Administrators can Fetch information again, choose proposed matches or adjust title/year; failed retries preserve old data. Stored match choices retain season/episode/history. Candidate posters use TMDB's image service; selected artwork caches locally.

### Manual corrections

Edit display title, type, description, genres, date/rating and series name/start year/season/episode per file. Reliable TMDB series group by ID; local series group by name/year. Manual classification overrides filename inference. Explicit metadata refetch from the edit form uses entered values and can replace prior manual information; background refresh does not silently overwrite it.

Custom JPEG/PNG/WebP posters/banners accept up to **8 MB / 16 megapixels** and are validated/re-encoded as JPEG. Empty uploads keep old images. Text saves first; an image error reports that text has already been saved. Source video, technical data, favorites and progress remain unchanged.

## Browser playback and format checks

`app/static/browser-capabilities.js` checks codec profile/level, bit depth, resolution, actual frame rate and selected audio independently for direct files and MSE/HLS. Supported H.264, HEVC, AV1 and VP9 can remux into fMP4 without video encoding. HEVC tests hvc1/hev1 and chooses the corresponding server tag. Confirmed AAC/AC3/EAC3 channel support preserves audio; otherwise only audio is converted where video can remain.

Unknown/missing API answers do not automatically reject SDR; explicit unsupported results do. HDR needs confirmed decoding and HDR output or the established desktop Chrome/Edge 121+ HDR-to-SDR display path. Both `video-dynamic-range` and `dynamic-range` are checked. Unknown/mobile profiles do not inherit that desktop exception. A documented Dolby Vision HDR10 base may be preserved while removing DV metadata; unverified DV profiles are rejected rather than assuming correct colors. Original can override a smoothness warning, never explicit unsupported.

Original compatible video is prioritized. Auto browser transcoding can reach **4K** for a 4K source when physical display resolution is at least 3840 × 2160 and target H.264/MSE support is confirmed smooth; otherwise its cap remains 1080p. Manual qualities and Windows/LG/Xbox/AirPlay retain their own rules. This is capability negotiation, not a continuous network speed test or adaptive bitrate ladder. Unknown throughput does not itself lower compatible original quality.

Format/decoder failures try Direct Play → compatible Direct Stream → Transcoding. Failed paths are remembered in the tab for ten minutes, including after seeks; network failures do not cause this codec downgrade. Before-playback badges are predictions; actual playback status and hardware results remain decisive. Capability checks stay local to the tab.

### Independent browser profiles

`browser-profiles.js` identifies Chrome, Edge, Firefox, Safari, Opera and Samsung Internet with separate desktop/Android/iOS IDs, Client Hints when available, specific-browser checks before generic compatibility tokens, and unknown-browser fallback. Names control buffering/probe policy, not automatic codec support.

| Profile | Forward/backward compressed HLS budget | Notes |
| --- | --- | --- |
| Chrome desktop | 64/32 MiB | Windows 4K HEVC Main 10/HDR + AAC playback and seeking checked. |
| Edge desktop | 64/32 MiB | Separate profile checked with the same 4K clip. |
| Other desktop profiles | 48/16 MiB | Conservative defaults, without a hardware-compatibility guarantee. |
| Mobile profiles | 48/16 MiB | Separate defaults; no inherited desktop HDR exception. |

Budgets become seconds using stream bitrate and respect the user's buffer setting. Browsers impose their own MSE quotas; one segment may exceed a time target. Native HLS/AirPlay use native buffers. Browser remux omits FFmpeg's `sidx` adjustment to preserve open-GOP frame timestamps without changing resolution.

Firefox desktop Direct Stream can prefetch **one next unencrypted segment**, bounded separately to **32 MiB**, while MSE retains 48/16 MiB. HLS reuses the transfer and actual timings; seek/close abort unnecessary work. Range/encrypted segments use normal HLS. Chrome, Edge, mobile and native HLS are unaffected. Controlled replay of a captured HEVC/HDR timing trace eliminated post-start buffer stops, but it does not guarantee total connection capacity or every Firefox decoder. Native H.264/fMP4 was also tested.

Profile regression checks:

```sh
node --test tests/test_browser_profiles.cjs tests/test_browser_buffer.cjs tests/test_browser_capabilities.cjs tests/test_browser_prefetch.cjs
```

### Diagnostics and controls

The player shows method, input/output resolution, bitrate, remux/audio/HDR reason, delivery origin, buffer seconds, cumulative/recent dropped frames, buffer-stop count and segment transfer time versus segment duration. These distinguish decoding trouble from an empty buffer. Subtitle status includes selected track, extracted lines and active cues. A single full-film timeline remains stable through stream changes and displays a still preview while seeking; late previews are discarded.

Controls include play/pause, ten-second skips, volume, quality, tracks and fullscreen, hiding during playback inactivity. Space/K, arrows, M and F work outside input/button focus. Unsupported HTML fullscreen can use the system video player.

## Transcoding, buffers and cleanup

NVIDIA encoding is used only after a real encoder test; CPU fallback remains. Lens/Flix may share a GPU but share VRAM/capacity without reservations or automatic priority. Start with two concurrent conversions and tune load.

Supported decode/scaling uses GPU after source validation. HDR first scales 10-bit on CUDA then tone-maps on OpenCL, reducing RAM transfers; older OpenCL and CPU paths are compatibility fallbacks. Burned subtitles still use CPU filters. Rebuild for OpenCL/dependency changes.

Bitrate depends on pixel area, frame rate, source bitrate and output codec; 60 fps gets more than 24 fps and HEVC less than H.264. Quality limits dimensions, including wide-film width, without upscaling smaller sources. Xbox retains H.264 8 Mbit/s and HEVC 25 Mbit/s limits. Compatible direct video remains preferred.

HLS jobs are monitored each second. FFmpeg pauses at the configured forward margin and resumes halfway back, based on completed/requested segments. HEAD requests do not advance consumption; native clients need no browser heartbeat for this buffer. Matroska uses pipe backpressure.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRANSCODE_BUFFER_SECONDS` | 180 | Forward buffer, minimum 10 seconds; resume at half. |
| `TRANSCODE_MIN_FREE_MB` | 2048 | Minimum free space during active jobs. |
| `TRANSCODE_CLEANUP` | Enabled | Set 0 to disable played-segment cleanup. |
| `TRANSCODE_RETAIN_SECONDS` | 180 | Retain played segments, minimum 60 seconds. |

Low disk space stops the active job, cleans temporary files and returns HTTP 507; finished jobs can still play. A paused FFmpeg process resumes before termination for cleanup. NVIDIA failure permits one CPU retry at the same output/track settings. MPEG-TS can continue with discontinuity; native fMP4/Matroska clients reopen at the current position because codec initialization cannot safely change in place. CPU failure is not retried indefinitely.

Updated web/LG/Xbox clients report completed seek position so played HLS segments more than the retention margin behind can be deleted; recently requested segments get an extra 60-second grace. AirPlay/older clients keep their segments. Rewind starts a new stream at the requested position. Only temporary segments are removed, never original media. Closing the player/inactivity releases streams; concurrency is configurable in the Hub deployment.

## Audio, subtitles and trailers

Select audio/subtitles in detail or Sound and text. Text SRT, ASS/SSA, WebVTT and MP4 tracks extract to cached WebVTT without video encoding; ASS typography/effects are not fully reproduced. PGS, DVD/VobSub and DVB tracks need burn-in/transcoding. Unknown formats are unavailable. Track choices survive seeking/quality changes, resetting for another title.

Sibling `.srt` files are discovered when opening track choices or starting playback, including existing titles without a library rescan. Matching filenames such as `Release.srt` or `Release.da.srt` may sit beside the video or up to two subdirectory levels below it. Language-only filenames such as `Subs/Danish.srt` require a single video in the parent directory, or an episode-specific folder such as `Subs/Release/Danish.srt`. Local files appear as `Lokal SRT`; filenames without a language code remain selectable as unknown language. Embedded and downloaded tracks remain available. Discovery ignores symlinks and hidden/buffer directories and is bounded to 64 directories and 4096 entries per directory. Original media and subtitle files are read without being rewritten.

Web and updated Xbox fetch text cues incrementally rather than waiting for full-file extraction. A far-forward resume may still wait until relevant cues are extracted. Completed tracks cache under `DATA_DIR/subtitles` and require authorization.

SubDL (API key) or OpenSubtitles (key/account/password) can be selected under Settings → Subtitles. Both configurations may be saved; only the active provider searches/downloads. Blank edits preserve secrets. Administrators manually search/select or Fetch subtitles with preferred/fallback languages; users can play downloaded tracks. Automatic fetching on new upload/library import is optional, defaults off on upgrades, requires a TMDB match and skips existing suitable text tracks. It neither backfills all old titles nor automatically retries failures; import continues on provider errors.

Downloaded SRT files persist in `DATA_DIR/subtitles/downloaded` and are reused across browser/desktop/TV and provider switches. The default preferred/fallback languages are Danish and English; both can be changed and fallback disabled. Removing credentials keeps files; deleting a film removes its downloads. Match by title/ID is not a timing guarantee for a release. Quotas depend on the account; tests use mocked provider answers. [SubDL API](https://subdl.com/api-doc).

Administrators on screens wider than 600 px can choose **Tilføj undertekster…** in the detail/player subtitle selector, including titles with no existing subtitle tracks. Upload is hidden on mobile; existing subtitle tracks remain selectable. The modal accepts drag-and-drop or file selection, up to 20 `.srt` files of 2 MiB each, with an editable language per file. Every file belongs to the currently displayed movie/episode. Uploads are validated, normalized to UTF-8 and saved as external tracks without a provider/key; identical content/language is reused. Successful files remain saved if another file in the batch fails. Added tracks become selectable immediately and persist across restarts alongside other external tracks; ordinary title deletion removes them.

Administrators can select an existing subtitle and choose **Download valgt undertekst** beneath the detail/player selector, including on mobile. Local sidecars, manual uploads and provider downloads are returned directly. Embedded text tracks export as SRT, while ASS/SSA styling is preserved in ASS; PGS exports as SUP and other supported bitmap tracks as subtitle-only MKS. Image subtitles are not OCR-converted. Exports leave source media unchanged, use a source-fingerprint cache, share the bounded extraction workers and have a 60-second extraction timeout and 128 MiB output limit. The download endpoint independently requires administrator access.

The first administrator gets an optional TMDB/subtitle setup wizard, with language/fallback choice, resumable progress and skip options. Other users/admins do not receive the automatic wizard. Configure later in Settings. TMDB saves without a live test; subtitle connections are tested before saving.

Trailers are fetched server-side with yt-dlp/Deno and converted to H.264/AAC MP4 for web, Windows and TV playback. Initial viewing waits for preparation; `/data/trailers` retains up to 20 entries, 24 hours after last use, with two preparations concurrently. YouTube may reject a server's address; errors are shown. Trailer playback does not change film progress. Rebuild the server for dependencies.

## Direct-video origin and AirPlay

Web can remain behind a tunnel while media uses a separate verified HTTPS origin. Configure Server → Direct video connection or Hub's gateway guide; the option defaults off. See [Caddy deployment](deploy/direct-media/README.md). Public DNS/router access is a prerequisite; simply saving a hostname does not create connectivity. Failed proof keeps settings unchanged; an unreachable direct route is not silently rerouted through the tunnel.

Safari's AirPlay picker appears beside fullscreen when native HLS/WebKit are available. On iPhone/iPad, local Safari playback uses its own native HLS profile without enabling AirPlay. Unsupported original video is converted to compatible H.264/AAC (normally up to 1080p automatically); compatible H.264 can play directly or be remuxed. Tapping AirPlay explicitly prepares a receiver-ready HLS stream; tap again when ready to choose the TV. Disconnecting restores local playback. Supported H.264 can retain original video; selected audio becomes stereo AAC. Text subtitles are separate selected-language WebVTT renditions. A manual Burn subtitles fallback requires conversion, as do image subtitles. Track/quality changes restart at the current position with a possible brief pause.

TV delivery uses stream-specific random tickets, not browser cookies. Requests keep tickets alive while a phone sleeps. AirPlay idle expiry is ten minutes; absolute lifetime is movie duration plus one hour, capped at 24 hours. Logout/player close revokes access. The TV must reach the chosen media origin without an external interactive login/challenge. Physical Apple hardware/color/output still requires verification beyond FFmpeg/UI fixtures.

## Phone remote

Open Remote on a signed-in desktop browser and scan the QR code. On the same trusted LAN, a phone controls the Flix pointer, click/scroll, back, playback, skips, quality, tracks and search without installing an app.

The code is single-use, expires after three minutes and pairs with one tab. Closing/reloading that tab ends pairing; connections last up to eight hours and require valid desktop login. It grants Flix navigation, not Windows control/admin access or the desktop cookie. Background phone suspension can interrupt/reconnect.

Copy `compose.override.example.yaml` to `compose.override.yaml`, set the actual LAN IP/`REMOTE_PUBLIC_URL`, then recreate. `Enable-Local-Remote.ps1 -LocalAddress <LAN-IP>` can add a local-subnet/private-network TCP 8096 firewall rule with administrator PowerShell. No router change is needed for a local test; external remote control requires HTTPS/WSS. There is no Pi image/automatic Wi-Fi setup.

## Windows and TV clients

- [Windows](desktop/README.md): bundled mpv opens original media with local hardware decoding, no server video transcoding. Server-loaded UI, local seeking/preview, audio passthrough with PCM fallback, diagnostics and GitHub Release updates.
- [LG webOS](lg/README.md): shared TV UI with Magic Remote navigation, capability checks, trailers, subtitles and next-episode countdown.
- [Samsung Tizen 2018+](samsung/README.md): Tizen 4.0 baseline, Samsung remote keys, native AVPlay, model-aware UHD/HDR10 checks and text subtitles. See the [physical-TV test guide](samsung/TEST-PAA-SAMSUNG-TV.md). Installation requires your Samsung certificate profile and TV DUID.
- [Xbox](xbox/README.md): UWP client, controller navigation, local phone-login page, HEVC/HDR10 paths and optional original TrueHD/DTS Matroska audio. Physical HDMI/Atmos output is not proven by server packet preservation.

Browser profile changes do not replace native client policies. Update server and client together for new API capabilities/seek previews. The bundled `/tv-api/info`, `/tv-api/login`, state/library/progress/stream endpoints require bearer tokens rather than browser cookies. Tokens last seven days and are stored hashed. Separate `/tv-media/` tickets scope playback and renew/revoke through authenticated APIs. Proxies on media origins must route both `/media/*` and `/tv-media/*`, without logging tickets.

The TV clients share Forside with Senest tilføjet above Se videre. Full-library filters and pagination remain available. Shared code comes from `xbox/tv` at build time; LG/Samsung standalone exports retain updated snapshots. Current clients: LG 0.1.11, Xbox 0.1.18 and Samsung 0.1.0.

The server phone-pairing `/tv-login` expires after five minutes and requires the updated API/static paths. Xbox's native local HTTP phone page can enter the server address on the phone instead; LG/Samsung first need the server address on TV. Older separate `fjordflix_tv.py`/TV overrides should be removed from `COMPOSE_FILE` when adopting the built-in API, retaining unrelated overrides, GPU settings and mounts.

## API integration, operations and tests

Hub access tokens can expose the ten latest grouped movie/series titles/posters and active streams to other apps through its [data API](https://github.com/qlerup/fjordhub/blob/main/docs/app-data-integration.md). External consumers use Hub's scoped token/image proxy rather than the app key.

Back up the complete persistent data/media storage, provider configuration and deployment environment. Standalone volume `fjordflix_fjordflix-data` survives rebuilds; Hub uses selected bind paths. Startup removes recognized historic generated demo movies only, retaining uploads/external library files. Preserve overrides/keys and verify restored code/schema compatibility.

```sh
docker compose ps
docker compose logs --tail 100 app
python -m pytest tests/test_hub.py tests/test_tv.py tests/test_media_delivery.py tests/test_stream_control.py tests/test_transcoding.py tests/test_airplay.py tests/test_tracks.py -q
```

Tests run from source with Python dependencies and FFmpeg/FFprobe, using isolated databases/clips rather than live libraries. Additional integration, remote, metadata, subtitle, onboarding, Xbox and browser tests are under `tests/`. Browser smoke fixtures use a disposable QA server, not production accounts. Local controlled playback is not a guarantee of every 4K/HDR display, sustained multi-viewer load or physical TV output. Native decoder quotas, available bandwidth and source formats remain relevant limits.
