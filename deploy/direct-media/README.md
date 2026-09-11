# Direct media gateway

The web domain (for example `film.gleruphub.dk`) can remain on Cloudflare Tunnel. The media domain must point directly to a reachable server, with Cloudflare proxy disabled (DNS-only). The app does not create this network route.

For a server which currently only has a Tunnel:

1. Create a DNS-only A record for your chosen media hostname pointing to your public IPv4. Only add an AAAA record if inbound IPv6 is configured too. CGNAT requires a different reachable gateway or private VPN route.
2. Forward TCP 80 and 443 on the router to the server running this gateway. If another reverse proxy already owns these ports, configure that proxy instead of starting a second one.
3. Copy `.env.example` to `.env`, fill in the actual hostname, and ensure `MEDIA_UPSTREAM` points to FjordFlix (8097 by default). Run `docker compose up -d` from this directory. Caddy obtains a TLS certificate once DNS and incoming connections work. This does not expose the app's admin API on the media hostname.
4. In FjordFlix, open **Server → Direkte videoforbindelse**. Webadresse is the normal web domain; for a managed install it is prefilled from FjordHub's saved external app URL where available. Enter the working direct HTTPS media origin and save. Use the configured web origin to open the app after reloading.
5. Play a film. Browser network requests for the original file, HLS playlist and all segments must use the media hostname. Login, playback authorization, progress and grant renewal stay on the web hostname. Verify from outside the LAN too; local testing may require NAT loopback or split DNS.

The app also supports `WEB_PUBLIC_URL` and `MEDIA_PUBLIC_URL` as initial defaults; values saved by an administrator take precedence. Clearing the media address disables separation. No network settings are changed by saving app settings.

Media grants expire after 120 seconds and are renewed every 30 seconds through the logged-in web session. They only authorize one original movie or one transcoding job, never administration or other films. Every media request rechecks the originating login and FjordHub access. Stopping playback revokes the grant. An already-transferring response cannot be withdrawn retroactively. URLs must not be logged by proxies; the app redacts them in its default Uvicorn access log. Do not enable proxy access logs containing full media request URLs.

Direct mode refuses media on the web hostname or requests with Cloudflare proxy headers. The old same-origin streaming endpoints are blocked while it is enabled. There is no automatic fallback through the tunnel. Uploads and posters are unchanged; large uploads through Cloudflare still require separate chunked-upload support.

If the direct route fails, fix DNS/TLS/port forwarding or disable direct mode in settings. Merely adding a hostname in FjordHub does not establish direct HTTPS connectivity.

Reference: [Caddy automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https) and [reverse proxy configuration](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
