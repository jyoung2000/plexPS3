"""Shared helpers for the movian-plex tools (Python 3 stdlib only)."""
import json
import os
import sys
import urllib.request
import urllib.error
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, '.env')
PS3_PLUGIN_DIR = '/dev_hdd0/game/HTSS00003/USRDIR/settings/installedplugins'
PS3_LOG_DIR = '/dev_hdd0/game/HTSS00003/USRDIR/cache/log'


def read_env():
    """Return key/value pairs from .env (git-ignored) merged with os.environ."""
    env = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ('PMS_URL', 'PS3_IP', 'PLEX_TOKEN', 'PLEX_CLIENT_ID'):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def write_env(updates):
    env = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding='utf-8') as f:
            for line in f:
                s = line.strip()
                if s and not s.startswith('#') and '=' in s:
                    k, v = s.split('=', 1)
                    env[k.strip()] = v.strip()
    env.update(updates)
    with open(ENV_FILE, 'w', encoding='utf-8') as f:
        f.write('# movian-plex local configuration. Never commit this file.\n')
        for k, v in env.items():
            f.write('%s=%s\n' % (k, v))
    try:
        os.chmod(ENV_FILE, 0o600)
    except OSError:
        pass


def client_id():
    env = read_env()
    cid = env.get('PLEX_CLIENT_ID')
    if not cid:
        cid = str(uuid.uuid4())
        write_env({'PLEX_CLIENT_ID': cid})
    return cid


def plex_headers(token=None, cid=None):
    h = {
        'Accept': 'application/json',
        'X-Plex-Product': 'Plex for Movian',
        'X-Plex-Version': '0.1.0',
        'X-Plex-Client-Identifier': cid or client_id(),
        'X-Plex-Platform': 'PlayStation 3',
        'X-Plex-Device': 'PlayStation 3',
        'X-Plex-Device-Name': 'Movian on PlayStation 3 (PC helper)',
        'X-Plex-Provides': 'player',
    }
    if token:
        h['X-Plex-Token'] = token
    return h


def http_json(method, url, headers=None, data=None, timeout=20):
    """Return (status, parsed_json_or_text)."""
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8', 'replace')
            status = resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        status = e.code
    try:
        return status, json.loads(body) if body.strip() else None
    except ValueError:
        return status, body


def redact(s):
    import re
    return re.sub(r'(X-Plex-Token=)[^&\s]+', r'\1***', str(s))


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)
