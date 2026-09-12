"""Original, illustrated demo movies. Generated locally without external downloads."""
import subprocess

STRESS_TITLE = 'Bitstorm · 4K · 120 Mbit/s'


def generate_stress(path, gpu):
    command = ['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
               'testsrc2=size=3840x2160:rate=24,noise=alls=12:allf=t:all_seed=42',
               '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '60',
               '-c:v', 'h264_nvenc' if gpu else 'libx264',
               '-preset', 'fast' if gpu else 'ultrafast',
               '-b:v', '120M', '-minrate', '120M', '-maxrate', '120M', '-bufsize', '240M',
               '-g', '48', '-pix_fmt', 'yuv420p']
    command += ['-rc', 'cbr'] if gpu else ['-x264-params', 'nal-hrd=cbr:filler=1']
    command += ['-c:a', 'aac', '-movflags', '+faststart', '-y', str(path)]
    subprocess.run(command, capture_output=True, check=True, timeout=1800)

CATALOG = [
    ('fjord', 'Fjordens ro', 30, 1920, 1080, '#071b38', '#32c7c2'),
    ('desert', 'Det sidste sollys', 60, 1920, 1080, '#431836', '#ffb65b'),
    ('orbit', 'Langt fra jorden', 120, 3840, 2160, '#070c28', '#8374ed'),
]


def artwork(kind, title, dark, light):
    shapes = {
        'fjord': '<path d="M0 800L400 190 750 750 1100 280 1600 880H0" fill="#123e58"/><path d="M290 360L400 190 520 370 406 315Z" fill="#c7f5ef"/><path d="M0 760Q800 630 1600 780V900H0" fill="#258593"/>',
        'desert': '<circle cx="1100" cy="310" r="160" fill="#ffd98f"/><path d="M0 700Q450 390 1000 730T1800 620V900H0" fill="#b75d55"/><path d="M0 820Q750 510 1600 780V900H0" fill="#6c3446"/>',
        'orbit': '<circle cx="1110" cy="470" r="245" fill="url(#planet)"/><ellipse cx="1110" cy="470" rx="400" ry="80" transform="rotate(-25 1110 470)" fill="none" stroke="#b4adff" stroke-width="20" opacity=".6"/>' + ''.join(f'<circle cx="{(i*173)%1600}" cy="{(i*97)%900}" r="{1+i%3}" fill="white" opacity=".65"/>' for i in range(65)),
    }[kind]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
    <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="{dark}"/><stop offset="1" stop-color="{light}"/></linearGradient><linearGradient id="planet"><stop stop-color="{light}"/><stop offset="1" stop-color="{dark}"/></linearGradient></defs>
    <path fill="url(#sky)" d="M0 0H1600V900H0Z"/>{shapes}
    <text x="90" y="110" fill="white" font-family="sans-serif" font-size="22" letter-spacing="8">FJORDFLIX · TESTFILM</text>
    <text x="90" y="800" fill="white" font-family="sans-serif" font-size="72" font-weight="bold">{title}</text></svg>'''


def generate(spec, path, gpu):
    kind, title, duration, width, height, dark, light = spec
    art = path.with_suffix('.svg')
    art.write_text(artwork(kind, title, dark, light), encoding='utf-8')
    try:
        # Slowly moving illustrations; silence avoids repetitive test tones.
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(art), '-f', 'lavfi', '-i',
                        'anullsrc=r=48000:cl=stereo', '-vf',
                        f"zoompan=z='1+0.06*on/{duration*24}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d={duration*24}:s={width}x{height}:fps=24",
                        '-t', str(duration), '-c:v', 'h264_nvenc' if gpu else 'libx264',
                        '-preset', 'fast' if gpu else 'ultrafast', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-movflags', '+faststart', '-y', str(path)],
                       capture_output=True, check=True, timeout=900)
    finally:
        art.unlink(missing_ok=True)
