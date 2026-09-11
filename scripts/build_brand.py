"""Rebuild brand exports: pip install pillow playwright; playwright install chromium."""
import io
import json
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1] / 'app/static/logos'
for folder in ('source', 'logos', 'icons', 'web'):
    (ROOT / folder).mkdir(parents=True, exist_ok=True)

DEFS = '''<defs>
<linearGradient id="blue" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#53ebf5"/><stop offset=".45" stop-color="#009eeb"/><stop offset="1" stop-color="#2455de"/></linearGradient>
<linearGradient id="water" x2="0" y2="1"><stop stop-color="#e0fcff"/><stop offset="1" stop-color="#00abc8"/></linearGradient>
<linearGradient id="mountain" x2="1" y2="1"><stop stop-color="#2275b9"/><stop offset="1" stop-color="#05274f"/></linearGradient>
<radialGradient id="bg" cx=".3" cy=".15" r="1"><stop stop-color="#0b315a"/><stop offset="1" stop-color="#020d24"/></radialGradient>
<clipPath id="window"><path d="M174 149 365 256 174 363Z"/></clipPath>
</defs>'''
MARK = '''<path d="M137 88Q137 65 158 77L434 236Q468 256 434 276L158 435Q137 447 137 424Z" fill="url(#blue)"/>
<path d="M174 149 365 256 174 363Z" fill="#041b36"/>
<g clip-path="url(#window)">
<path d="M157 292 225 191 282 266 316 234 388 309V378H157Z" fill="url(#mountain)"/>
<path d="m225 191-30 45 23-12 8 28 9-26 27 14Z" fill="#f0fcff"/>
<path d="m316 234-18 22 15-5 7 17 5-13 22 18Z" fill="#bdeefa"/>
<path d="M169 308 219 280 247 306 290 286 333 304 385 280V377H169Z" fill="#007591"/>
<path d="M258 300h42l-31 17h28l-48 21h27l-57 34h-53l60-34h-23l46-21h-17Z" fill="url(#water)"/>
</g>'''

def svg(body, width=512, height=512):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="FjordFlix">{DEFS}{body}</svg>'

def tile(maskable=False):
    transform = 'translate(77 77) scale(.7)' if maskable else 'translate(15 15) scale(.94)'
    return svg(f'<rect width="512" height="512" fill="url(#bg)"/><g transform="{transform}">{MARK}</g>')

def wordmark(light=False, stacked=False):
    ink = '#082449' if light else '#f0f7ff'
    if stacked:
        return svg(f'<g transform="translate(128 0)">{MARK}</g><text x="384" y="568" text-anchor="middle" fill="{ink}" font-family="Arial,sans-serif" font-weight="700" font-size="78" letter-spacing="-3">Fjord<tspan fill="#009fd5">Flix</tspan></text>', 768, 640)
    return svg(f'<g transform="translate(0 0) scale(.48)">{MARK}</g><text x="255" y="164" fill="{ink}" font-family="Arial,sans-serif" font-weight="700" font-size="108" letter-spacing="-4">Fjord<tspan fill="#009fd5">Flix</tspan></text>', 720, 256)

sources = {'fjordflix-mark': svg(MARK), 'fjordflix-app-icon': tile(),
           'fjordflix-maskable': tile(True), 'fjordflix-horizontal-dark': wordmark(),
           'fjordflix-horizontal-light': wordmark(True), 'fjordflix-stacked-dark': wordmark(stacked=True),
           'fjordflix-stacked-light': wordmark(True, True)}
for name, source in sources.items():
    (ROOT / 'source' / (name + '.svg')).write_text(source, encoding='utf-8')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(device_scale_factor=2)
    def render(source):
        page.set_content('<style>body{margin:0}svg{display:block}</style>' + source)
        return Image.open(io.BytesIO(page.locator('svg').screenshot(omit_background=True))).convert('RGBA')
    def save(im, path, size=None, opaque=False):
        if size:
            im = im.resize((size, size), Image.Resampling.LANCZOS)
        if opaque:
            im = im.convert('RGB')
        im.save(ROOT / path)
    mark = render(sources['fjordflix-mark'])
    icon = render(tile())
    mask = render(tile(True))
    save(icon, 'logos/fjordflix-app-icon-master.png', 1024, True)
    save(icon, 'source/source-icon_square.png', 1024, True)
    save(mark, 'logos/fjordflix-logo-mark-transparent.png')
    white = Image.new('RGBA', mark.size, 'white'); white.alpha_composite(mark)
    save(white, 'logos/fjordflix-logo-mark-white-bg.png')
    for variant in ('horizontal', 'stacked'):
        for mode in ('dark', 'light'):
            im = render(sources[f'fjordflix-{variant}-{mode}'])
            save(im, f'logos/fjordflix-logo-{variant}-{mode}.png')
            if mode == 'dark':
                save(im, f'logos/fjordflix-logo-{variant}-transparent.png')
    save(mark, 'icons/fjordflix-mark-transparent-512.png', 512)
    save(icon, 'icons/app-icon-1024x1024.png', 1024, True)
    for size in (16, 32, 48, 64, 128, 256):
        # Simple play silhouette remains clear in tiny browser tabs.
        tiny = render(svg('<path d="M130 66 453 256 130 446Z" fill="url(#blue)"/>')) if size <= 32 else mark
        save(tiny, f'icons/favicon-{size}x{size}.png', size)
    favicon = Image.open(ROOT / 'icons/favicon-256x256.png')
    favicon.save(ROOT / 'icons/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    for name, size, im in [('apple-touch-icon', 180, icon), ('android-chrome-192x192', 192, icon), ('android-chrome-512x512', 512, icon), ('pwa-maskable-512x512', 512, mask), ('mstile-150x150', 150, icon)]:
        save(im, f'icons/{name}.png', size, True)
    browser.close()

for name in ('favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png', 'favicon-48x48.png', 'apple-touch-icon.png', 'android-chrome-192x192.png', 'android-chrome-512x512.png', 'pwa-maskable-512x512.png', 'mstile-150x150.png'):
    (ROOT / 'web' / name).write_bytes((ROOT / 'icons' / name).read_bytes())
manifest = {'id': '/', 'name': 'FjordFlix', 'short_name': 'FjordFlix', 'lang': 'da', 'start_url': '/', 'scope': '/', 'display': 'standalone', 'background_color': '#101014', 'theme_color': '#101014', 'icons': [
    {'src': f'/static/logos/web/{name}.png', 'sizes': f'{size}x{size}', 'type': 'image/png', 'purpose': purpose}
    for name, size, purpose in [('android-chrome-192x192', 192, 'any'), ('android-chrome-512x512', 512, 'any'), ('pwa-maskable-512x512', 512, 'maskable')]]}
for name in ('site.webmanifest', 'manifest.webmanifest'):
    (ROOT / 'web' / name).write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
(ROOT / 'web/browserconfig.xml').write_text('<browserconfig><msapplication><tile><square150x150logo src="/static/logos/web/mstile-150x150.png"/><TileColor>#041b36</TileColor></tile></msapplication></browserconfig>\n', encoding='utf-8')
# Keep the old catalog URL valid for cached FjordHub manifests.
(ROOT.parent / 'fjordflix.svg').write_text(tile(), encoding='utf-8')
print('Brand package exported to', ROOT)
