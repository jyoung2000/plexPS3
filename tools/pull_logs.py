#!/usr/bin/env python3
"""
Download Movian's log files from the PS3 over webMAN FTP into ./logs/ and
print the last 80 lines that mention plex.

Movian writes <cache_path>/log/movian-N.log (src/api/httpcontrol.c:77,
APPNAME from configure); on the PS3 cache_path is
/dev_hdd0/game/HTSS00003/USRDIR/cache (src/arch/ps3/ps3_main.c:441-442).
The same files are also served by Movian itself while it runs:
http://<PS3_IP>:42000/api/logfile/0 (src/api/httpcontrol.c:686).

  python tools/pull_logs.py [PS3_IP] [--all]
"""
import ftplib
import os
import re
import sys
import urllib.request

import plexcommon as pc

LOG_DIR = os.path.join(pc.ROOT, 'logs')


def via_http(ip):
    """While Movian is running its HTTP server on :42000 can hand us the log."""
    out = []
    for n in range(0, 2):
        try:
            with urllib.request.urlopen('http://%s:42000/api/logfile/%d?mode=download' % (ip, n), timeout=5) as r:
                data = r.read()
        except Exception:
            break
        p = os.path.join(LOG_DIR, 'movian-%d.log' % n)
        with open(p, 'wb') as f:
            f.write(data)
        out.append(p)
    return out


def via_ftp(ip, all_files):
    out = []
    ftp = ftplib.FTP()
    ftp.connect(ip, 21, timeout=20)
    ftp.login()
    ftp.set_pasv(True)
    try:
        ftp.cwd(pc.PS3_LOG_DIR)
    except ftplib.error_perm:
        # older builds used the showtime name
        ftp.cwd(pc.PS3_LOG_DIR.replace('cache/log', 'cache/log'))
    names = []
    ftp.retrlines('NLST', names.append)
    names = [n.split('/')[-1] for n in names if re.search(r'\.log$', n)]
    names.sort()
    if not all_files:
        names = [n for n in names if re.search(r'-0\.log$', n)] or names[-1:]
    for n in names:
        p = os.path.join(LOG_DIR, n)
        with open(p, 'wb') as f:
            ftp.retrbinary('RETR ' + n, f.write)
        out.append(p)
    ftp.quit()
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    env = pc.read_env()
    ip = args[0] if args else env.get('PS3_IP')
    if not ip:
        pc.die('PS3 IP unknown. Pass it as an argument or set PS3_IP in .env')
    os.makedirs(LOG_DIR, exist_ok=True)

    files = via_http(ip)
    if files:
        print('Fetched from Movian HTTP server (:42000): %s' % ', '.join(os.path.basename(f) for f in files))
    else:
        try:
            files = via_ftp(ip, '--all' in sys.argv)
        except Exception as e:
            pc.die('Could not fetch logs over FTP (%s). Is webMAN running and the PS3 on?' % e)
        print('Fetched over FTP: %s' % ', '.join(os.path.basename(f) for f in files))

    lines = []
    for f in files:
        with open(f, 'r', encoding='utf-8', errors='replace') as fh:
            for line in fh:
                if re.search(r'plex|ecmascript|duktape|videoparams|hls', line, re.I):
                    lines.append(pc.redact(line.rstrip('\n')))
    print()
    print('--- last %d matching lines ---' % min(80, len(lines)))
    for line in lines[-80:]:
        print(line)
    if not lines:
        print('(no lines mentioning plex; is the plugin installed and Debug logging on in Settings > Plex?)')


if __name__ == '__main__':
    main()
