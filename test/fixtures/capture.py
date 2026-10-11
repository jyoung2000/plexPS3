#!/usr/bin/env python3
"""
Capture trimmed JSON fixtures from a live Plex Media Server for the unit tests.

  PMS_URL=http://ip:32400 [PLEX_TOKEN=...] python test/fixtures/capture.py

Writes test/fixtures/*.json. Tokens, file paths and server identifiers are
redacted so the fixtures can live in git.
"""
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools'))
import plexcommon as pc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
env = pc.read_env()
PMS = (env.get('PMS_URL') or 'http://127.0.0.1:32400').rstrip('/')
TOKEN = env.get('PLEX_TOKEN') or ''


def get(path, params=None):
    params = dict(params or {})
    if TOKEN:
        params['X-Plex-Token'] = TOKEN
    url = PMS + path + ('?' + urllib.parse.urlencode(params) if params else '')
    status, body = pc.http_json('GET', url, headers={'Accept': 'application/json'})
    if status != 200 or not isinstance(body, dict):
        raise SystemExit('GET %s -> %s' % (path, status))
    return body['MediaContainer']


def scrub(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ('file', 'machineIdentifier', 'uuid'):
                out[k] = 'REDACTED'
            else:
                out[k] = scrub(v)
        return out
    if isinstance(obj, list):
        return [scrub(x) for x in obj]
    if isinstance(obj, str):
        return re.sub(r'X-Plex-Token=[^&]+', 'X-Plex-Token=REDACTED', obj)
    return obj


def save(name, data):
    with open(os.path.join(HERE, name + '.json'), 'w', encoding='utf-8') as f:
        json.dump(scrub(data), f, indent=1, sort_keys=True)
        f.write('\n')
    print('wrote %s.json' % name)


def first_media_matching(section, pred):
    items = get('/library/sections/%s/all' % section).get('Metadata', [])
    for m in items:
        full = get('/library/metadata/%s' % m['ratingKey'])['Metadata'][0]
        if pred(full):
            return full
    return None


def main():
    secs = get('/library/sections')
    save('sections', secs)
    movies = [d for d in secs['Directory'] if d['type'] == 'movie']
    shows = [d for d in secs['Directory'] if d['type'] == 'show']
    music = [d for d in secs['Directory'] if d['type'] == 'artist']
    if not movies:
        raise SystemExit('need a movie library')
    sec = movies[0]['key']

    save('section_all_page1', get('/library/sections/%s/all' % sec, {'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 5}))

    def vid(codec, bit_depth=None, min_height=0):
        def pred(m):
            for md in m.get('Media', []):
                if md.get('videoCodec') != codec:
                    continue
                for p in md.get('Part', []):
                    for s in p.get('Stream', []):
                        if s.get('streamType') == 1 and (bit_depth is None or s.get('bitDepth') == bit_depth) and s.get('height', 0) >= min_height:
                            return True
            return False
        return pred

    fixtures = {
        'metadata_h264_8bit_1080p': vid('h264', 8, 1080),
        'metadata_hevc_10bit_4k': vid('hevc', 10, 2160),
        'metadata_h264_10bit': vid('h264', 10),
        'metadata_mpeg2': vid('mpeg2video'),
    }
    for name, pred in fixtures.items():
        m = first_media_matching(sec, pred)
        if m:
            save(name, {'Metadata': [m]})
        else:
            print('WARNING: no item for %s' % name)

    save('hubs_search', get('/hubs/search', {'query': 'a', 'limit': 5}))
    save('first_character', get('/library/sections/%s/firstCharacter' % sec))
    save('filter_genre', get('/library/sections/%s/genre' % sec))
    save('on_deck', get('/library/onDeck'))
    if shows:
        sh = get('/library/sections/%s/all' % shows[0]['key'])['Metadata'][0]
        seasons = get('/library/metadata/%s/children' % sh['ratingKey'])
        save('show_children', seasons)
        eps = get('/library/metadata/%s/children' % seasons['Metadata'][0]['ratingKey'])
        save('season_children', eps)
    if music:
        ar = get('/library/sections/%s/all' % music[0]['key'])['Metadata'][0]
        albums = get('/library/metadata/%s/children' % ar['ratingKey'])
        tracks = get('/library/metadata/%s/children' % albums['Metadata'][0]['ratingKey'])
        save('album_tracks', tracks)


if __name__ == '__main__':
    main()
