'use strict';
// Shared setup for live tests: reads PMS_URL / PLEX_TOKEN from .env (or the
// environment) and builds a plexapi client over the real HTTP shim.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const env = {};
try {
  for(const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if(m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch(e) {}
for(const k of ['PMS_URL', 'PLEX_TOKEN', 'PS3_IP']) if(process.env[k]) env[k] = process.env[k];

const PMS_URL = (env.PMS_URL || '').replace(/\/+$/, '');
const PLEX_TOKEN = env.PLEX_TOKEN || '';

function makeEnv(extra) {
  const loader = require('../shim/loader');
  return loader.create(Object.assign({ storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'plex-live-')) }, extra || {}));
}

function makeApi() {
  const e = makeEnv();
  const http = e.require('movian/http');
  const plexapi = e.require('lib/plexapi');
  const api = plexapi.create({
    http: http.request,
    identity: { clientId: 'movian-plex-livetest-' + process.pid, product: 'Plex for Movian', version: '0.1.0-test', platform: 'PlayStation 3', platformVersion: 'test', device: 'PlayStation 3', deviceName: 'Movian live test', model: 'CECH' },
    getServer: () => PMS_URL,
    getToken: () => PLEX_TOKEN,
    log: () => {}
  });
  return { api, env: e };
}

// Load the real plugin with the live server configured in its settings.
function loadPlugin(opts) {
  const e = makeEnv(opts);
  const world = e.loadPlugin();
  world.settings.items.serverUrl.value = PMS_URL;
  world.settings.items.token.value = PLEX_TOKEN;
  const st = e.require('movian/store').create('plex');
  st.librariesShown = true;   // skip the first-run library chooser redirect
  return { env: e, world, store: st };
}

function ffprobe(file) {
  const args = ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,profile,pix_fmt,level,width,height,channels', '-of', 'json'];
  if(!spawnSync('ffprobe', ['-version']).error) {
    return JSON.parse(execFileSync('ffprobe', args.concat([file])).toString()).streams;
  }
  // fall back to a Docker ffmpeg image when ffprobe is not installed
  const out = execFileSync('docker', ['run', '--rm', '-v', path.dirname(file) + ':/w', '--entrypoint', 'ffprobe',
    'jrottenberg/ffmpeg:4.4-alpine'].concat(args, ['/w/' + path.basename(file)]));
  return JSON.parse(out.toString()).streams;
}

module.exports = { PMS_URL, PLEX_TOKEN, makeApi, makeEnv, loadPlugin, ffprobe, root, configured: !!PMS_URL };
