"""Authenticated, original-file playback for the Windows client."""
from fastapi import Depends, Request, HTTPException
from fastapi.responses import RedirectResponse


def register(main):
    @main.app.get('/downloads/windows')
    def installer():
        return RedirectResponse('https://github.com/qlerup/fjordflix/releases/latest/download/FjordFlix-Setup.exe')

    @main.app.post('/api/desktop/movies/{mid}/play')
    def play(mid: str, data: main.Playback, request: Request, u=Depends(main.user)):
        row, meta = main.movie(mid)
        try:
            audio, subtitle = main.tracks.select(meta, data.audio_track, data.subtitle_track)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        available = main.tracks.displayed(meta)
        result = main.media.issue({'session': None}, request, mid, main.db, force=True)
        def ordinal(items, chosen):
            return next((i + 1 for i, t in enumerate(items) if chosen and t['index'] == chosen['index']), 'no')
        result.update(title=row['title'],
                      start=min(data.start, max(0, meta.get('duration', 0) - 1)),
                      audio=ordinal(available.get('audio', []), audio),
                      subtitle=ordinal([t for t in available.get('subtitles', []) if not t.get('external')], subtitle))
        if subtitle and subtitle.get('external'):
            base = result['url'].rsplit('/file', 1)[0]
            result['subtitle_url'] = f"{base}/subtitles/{subtitle['index']}.vtt"
        return result

    @main.app.get('/media/{ticket}/movies/{mid}/subtitles/{index}.vtt')
    def subtitle(ticket: str, mid: str, index: int):
        u = main.media.validate(ticket, main.db, main.session_user, mid=mid)
        return main.movie_subtitles(mid, index, u)
