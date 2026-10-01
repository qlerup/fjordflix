"""Test-runner-only clips, uploaded through the same API as user media."""
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urljoin


def clip_bytes():
    with tempfile.TemporaryDirectory(prefix='fjordflix-qa-') as folder:
        path = Path(folder) / 'QA clip.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i',
                        'testsrc2=size=3840x2160:rate=24', '-f', 'lavfi', '-i',
                        'sine=frequency=220:sample_rate=48000', '-t', '12',
                        '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '35M',
                        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart',
                        '-y', str(path)], check=True, timeout=180)
        return path.read_bytes()


def upload_clip(page, count=1):
    content = clip_bytes()
    for index in range(count):
        response = page.request.put(urljoin(page.url, f'/api/upload?filename=QA%20clip%20{index+1}.mp4'),
                                    data=content, timeout=180000)
        assert response.ok, response.text()
    page.evaluate('refresh()')
