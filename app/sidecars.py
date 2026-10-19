"""Discover sibling SRT tracks without moving or rewriting media files."""
import hashlib
from itertools import islice
import os
from pathlib import Path
import re

from app.tracks import language

# Separate from embedded indices and downloaded provider tracks (<= 2**49).
OFFSET = 2**50
LIMIT = 16 * 1024**2
LANGUAGES = {'da','en','sv','no','nb','fi','de','fr','es','it','pt','nl','pl','is','ar','ja','ko','zh','ru','uk','tr','he'}
ALIASES = {'dk':'da','danish':'da','swedish':'sv','norwegian':'no','fin':'fi','finnish':'fi',
           'dutch':'nl','dut':'nl','nld':'nl','ita':'it','por':'pt'}
SUB_FOLDERS = {'subs','subtitles','undertekster','subtitle'}
VIDEO_EXTENSIONS = {'.mkv','.mp4','.m4v','.avi','.mov','.wmv','.webm','.ts','.m2ts'}


def nearby_files(folder):
    """Bound discovery to the video directory and two subdirectory levels."""
    pending = [(folder, 0)]
    visited = 0
    while pending and visited < 64:
        directory, depth = pending.pop(0)
        visited += 1
        try:
            with os.scandir(directory) as stream:
                entries = sorted(islice(stream, 4096), key=lambda entry: entry.name.casefold())
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    if depth < 2 and not entry.name.startswith(('.', '#', '@')):
                        pending.append((Path(entry.path), depth + 1))
                elif entry.is_file(follow_symlinks=False):
                    yield entry
            except OSError:
                continue


def siblings(video):
    video = Path(video).resolve()
    try:
        if not video.is_file():
            return []
    except OSError:
        return []
    stem = video.stem.casefold()
    entries = list(nearby_files(video.parent))
    single_video = sum(Path(e.path).parent == video.parent and Path(e.name).suffix.lower() in VIDEO_EXTENSIONS for e in entries) == 1
    found = []
    for entry in entries:
        name = Path(entry.name)
        candidate = name.stem.casefold()
        if name.suffix.lower() != '.srt':
            continue
        relative = Path(entry.path).relative_to(video.parent)
        named_match = candidate == stem or candidate.startswith(stem + '.')
        generic_tokens = re.split(r'[. _-]+', candidate)
        generic_codes = [ALIASES.get(token, language(token)) for token in generic_tokens]
        # "Subs/Danish.srt" is unambiguous only when this directory has one video.
        own_folder = any(part.casefold() == stem for part in relative.parts[:-1])
        generic_match = ((single_video or own_folder) and len(relative.parts) > 1 and relative.parts[0].casefold() in SUB_FOLDERS
                         and any(code in LANGUAGES for code in generic_codes)
                         and all(code in LANGUAGES or token in {'forced','sdh','hi','cc'} for token,code in zip(generic_tokens,generic_codes)))
        if not named_match and not generic_match:
            continue
        try:
            if entry.is_symlink() or not entry.is_file(follow_symlinks=False) or not 0 < entry.stat(follow_symlinks=False).st_size <= LIMIT:
                continue
        except OSError:
            continue
        suffix = name.stem[len(video.stem):].strip('.') if named_match else name.stem
        tokens = re.split(r'[. _-]+', suffix.casefold())
        languages = [ALIASES.get(token, language(token)) for token in tokens]
        code = next((code for code in languages if code in LANGUAGES), 'und')
        index = OFFSET + int(hashlib.sha256(relative.as_posix().encode('utf-8')).hexdigest()[:12], 16)
        track = {'index':index, 'codec':'subrip', 'language':code,
                 'title':'Lokal SRT' + ((' · ' + suffix[:100]) if suffix else ' (uden sprogkode)'),
                 'default':False, 'forced':'forced' in tokens,
                 'hearing_impaired':any(t in tokens for t in ('sdh','hi','cc')),
                 'delivery':'text', 'external':True, 'sidecar':True}
        found.append((track, Path(entry.path)))
    return found


def metadata(meta, video):
    return {**meta, 'sidecar_subtitles':[track for track, _ in siblings(video)]}


def subtitle_path(video, index):
    for track, path in siblings(video):
        if track['index'] == index:
            return path
    raise ValueError('Den lokale undertekstfil findes ikke længere ved videoen.')
