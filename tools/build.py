#!/usr/bin/env python3
"""
Lint the plugin (ESLint, ES5) and zip plugin/ into dist/plex.zip with
plugin.json at the zip root, which is what Movian expects
(src/plugins.c: "zip://%s/plugin.json").

  python tools/build.py            # lint + zip
  python tools/build.py --no-lint  # zip only (no Node on this machine)
"""
import os
import shutil
import subprocess
import sys
import zipfile

import plexcommon as pc

PLUGIN_DIR = os.path.join(pc.ROOT, 'plugin')
DIST = os.path.join(pc.ROOT, 'dist')
OUT = os.path.join(DIST, 'plex.zip')


def lint():
    eslint = shutil.which('npx') or shutil.which('npx.cmd')
    if not eslint:
        print('npx not found: skipping lint (install Node 18+ to enable the ES5 check)')
        return
    print('ESLint (ecmaVersion 5) over plugin/ ...')
    r = subprocess.run([eslint, '--no-install', 'eslint', 'plugin/'], cwd=pc.ROOT)
    if r.returncode != 0:
        pc.die('Lint failed. Fix the errors above before building.')


def build():
    os.makedirs(DIST, exist_ok=True)
    files = []
    for dirpath, dirnames, filenames in os.walk(PLUGIN_DIR):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        for fn in sorted(filenames):
            if fn.startswith('.') or fn.endswith(('.pyc', '~')):
                continue
            full = os.path.join(dirpath, fn)
            files.append((full, os.path.relpath(full, PLUGIN_DIR).replace(os.sep, '/')))
    if not any(rel == 'plugin.json' for _, rel in files):
        pc.die('plugin/plugin.json missing')
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        for full, rel in sorted(files, key=lambda x: x[1]):
            info = zipfile.ZipInfo(rel, date_time=(2024, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, 'rb') as f:
                z.writestr(info, f.read())
    size = os.path.getsize(OUT)
    print('Built %s (%d files, %d bytes)' % (os.path.relpath(OUT, pc.ROOT), len(files), size))
    for _, rel in sorted(files, key=lambda x: x[1]):
        print('  ' + rel)
    return OUT


def main():
    if '--no-lint' not in sys.argv:
        lint()
    build()


if __name__ == '__main__':
    main()
