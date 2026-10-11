#!/usr/bin/env python3
"""
Build dist/plex.zip and copy it to the PS3 over webMAN's FTP server.

  python tools/deploy.py                 # uses PS3_IP from .env or env
  python tools/deploy.py 192.168.1.50    # explicit IP
  python tools/deploy.py --no-lint ...

Target: ftp://<PS3_IP>/dev_hdd0/game/HTSS00003/USRDIR/settings/installedplugins/plex.zip
(Movian scans <persistent_path>/installedplugins/*.zip at start-up,
src/plugins.c:757). Restart Movian afterwards.

Manual alternative (USB): copy dist/plex.zip to a FAT32 stick, start Movian,
open the USB drive on the home screen, select plex.zip, press X, Install.
"""
import ftplib
import os
import sys

import plexcommon as pc
import build


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    env = pc.read_env()
    ip = args[0] if args else env.get('PS3_IP')
    if not ip:
        pc.die('PS3 IP unknown. Pass it as an argument or set PS3_IP in .env')

    if '--no-lint' not in sys.argv:
        build.lint()
    zip_path = build.build()

    print('Connecting to ftp://%s (webMAN, anonymous, passive) ...' % ip)
    try:
        ftp = ftplib.FTP()
        ftp.connect(ip, 21, timeout=20)
        ftp.login()  # webMAN accepts anonymous
        ftp.set_pasv(True)
    except Exception as e:
        print('FTP connection failed: %s' % e)
        print_manual(zip_path, ip)
        sys.exit(1)

    try:
        parts = pc.PS3_PLUGIN_DIR.strip('/').split('/')
        path = ''
        for p in parts:
            path += '/' + p
            try:
                ftp.cwd(path)
            except ftplib.error_perm:
                print('  creating %s' % path)
                ftp.mkd(path)
                ftp.cwd(path)
        with open(zip_path, 'rb') as f:
            ftp.storbinary('STOR plex.zip', f)
        size = None
        try:
            size = ftp.size('plex.zip')
        except Exception:
            pass
        print('Uploaded plex.zip to %s%s' % (pc.PS3_PLUGIN_DIR, (' (%d bytes on PS3)' % size) if size else ''))
        ftp.quit()
    except Exception as e:
        print('FTP upload failed: %s' % e)
        print_manual(zip_path, ip)
        sys.exit(1)

    print()
    print('Done. Quit Movian on the PS3 and start it again; Plex appears on the home screen.')
    print('Check the file landed: http://%s%s/' % (ip, pc.PS3_PLUGIN_DIR))


def print_manual(zip_path, ip):
    print()
    print('Manual install instead:')
    print('  USB: copy %s to a FAT32 USB stick, start Movian, open the USB drive on the' % zip_path)
    print('       home screen, select plex.zip, press X and choose Install.')
    print('  FTP: with WinSCP/FileZilla/Explorer open ftp://%s (no login) and drop plex.zip into' % ip)
    print('       %s/ (create installedplugins if missing). Do not unzip it.' % pc.PS3_PLUGIN_DIR)


if __name__ == '__main__':
    main()
