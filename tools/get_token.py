#!/usr/bin/env python3
"""
plex.tv PIN login from a PC. Use this when the PS3 cannot reach plex.tv.

  python tools/get_token.py            # prints a 4-character code
  -> open https://plex.tv/link on any device, sign in, type the code
  -> the token is written to .env (PLEX_TOKEN=...) and printed once

Then enter the token and your server address (http://<ip>:32400) in
Movian > Settings > Plex, or let tools/deploy.py pre-fill nothing: the
plugin reads the token from its own settings only.
"""
import sys
import time

import plexcommon as pc


def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    cid = pc.client_id()
    status, pin = pc.http_json('POST', 'https://plex.tv/api/v2/pins?strong=false',
                               headers=pc.plex_headers(cid=cid), data=b'')
    if status != 201 or not isinstance(pin, dict) or not pin.get('code'):
        pc.die('plex.tv refused to create a PIN (HTTP %s): %s' % (status, pin))
    code = pin['code']
    pin_id = pin['id']
    expires = int(pin.get('expiresIn', 900))
    print()
    print('  Your code:   %s' % '  '.join(code))
    print()
    print('  Open  https://plex.tv/link  on your phone or PC, sign in and enter the code.')
    print('  (The code expires in %d minutes. Press Ctrl-C to abort.)' % (expires // 60))
    print()
    deadline = time.time() + expires
    token = None
    try:
        while time.time() < deadline:
            time.sleep(2)
            status, info = pc.http_json('GET', 'https://plex.tv/api/v2/pins/%s' % pin_id,
                                        headers=pc.plex_headers(cid=cid))
            if status == 200 and isinstance(info, dict) and info.get('authToken'):
                token = info['authToken']
                break
            sys.stdout.write('.')
            sys.stdout.flush()
    except KeyboardInterrupt:
        pc.die('\nAborted.')
    print()
    if not token:
        pc.die('No link within the time limit. Run the script again for a new code.')

    pc.write_env({'PLEX_TOKEN': token})
    status, user = pc.http_json('GET', 'https://plex.tv/api/v2/user', headers=pc.plex_headers(token, cid))
    who = user.get('username') if isinstance(user, dict) else '?'
    print('  Linked as %s. Token saved to .env (PLEX_TOKEN).' % who)
    print()
    print('  PLEX_TOKEN=%s' % token)
    print()
    status, res = pc.http_json('GET', 'https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=0',
                               headers=pc.plex_headers(token, cid))
    if status == 200 and isinstance(res, list):
        servers = [r for r in res if 'server' in str(r.get('provides', ''))]
        if servers:
            print('  Your servers (use the http LAN address in Movian > Settings > Plex > Server URL):')
            for s in servers:
                conns = [c for c in s.get('connections', []) if not c.get('relay')]
                lan = [c for c in conns if c.get('local') and c.get('protocol') == 'http']
                others = [c for c in conns if c not in lan]
                for c in lan or others:
                    print('    %-30s http://%s:%s%s' % (s.get('name'), c.get('address'), c.get('port'),
                                                        '  (LAN)' if c.get('local') else ''))
                if s.get('accessToken') and s['accessToken'] != token:
                    print('      shared server: use its own token  %s' % s['accessToken'])
    print('  This token is a password. Do not commit .env or paste it in bug reports.')


if __name__ == '__main__':
    main()
