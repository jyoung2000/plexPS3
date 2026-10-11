'use strict';
// Live tests against a real Plex Media Server (PMS_URL / PLEX_TOKEN in .env).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('./_env');

const skip = L.configured ? false : 'PMS_URL not set in .env (add PMS_URL=http://ip:32400 and PLEX_TOKEN from tools/get_token.py)';
const { api, env } = L.configured ? L.makeApi() : { api: null, env: null };

// Discovered once at load time so per-test skip conditions can use them.
let sections = [];
let largest = null;
let movieSection = null;
let showSection = null;
let validation = null;
if(L.configured) {
  validation = api.validate();
  sections = validation.sections || [];
  for(const s of sections) {
    const r = api.sectionAll(s.key, {}, 0, 1);
    if(r && (!largest || r.total > largest.total)) largest = Object.assign({ total: r.total }, s);
  }
  movieSection = sections.filter(s => s.type === 'movie')[0] || null;
  showSection = sections.filter(s => s.type === 'show')[0] || null;
}

test('auth validates: /identity and /library/sections answer', { skip }, () => {
  assert.ok(validation.ok, JSON.stringify(validation));
  assert.ok(validation.machineIdentifier);
  assert.ok(sections.length > 0, 'server has libraries');
  console.log('    sections:', sections.map(s => s.key + ':' + s.type + ':' + s.title).join(', '));
});

test('paging: page 2 of the largest section returns different items than page 1', { skip }, () => {
  assert.ok(largest, 'largest section known');
  const size = Math.max(1, Math.min(50, Math.floor(largest.total / 2)));
  const p1 = api.sectionAll(largest.key, { sort: 'titleSort:asc' }, 0, size);
  const p2 = api.sectionAll(largest.key, { sort: 'titleSort:asc' }, size, size);
  assert.ok(p1 && p2);
  assert.strictEqual(p1.total, largest.total);
  assert.ok(p1.items.length > 0 && p2.items.length > 0, 'both pages have items (' + p1.items.length + ', ' + p2.items.length + ')');
  const k1 = new Set(p1.items.map(m => m.ratingKey));
  assert.ok(p2.items.every(m => !k1.has(m.ratingKey)), 'no overlap between pages');
});

test('open a show down to an episode', { skip: skip || (!showSection && 'no TV library') }, () => {
  const shows = api.sectionAll(showSection.key, {}, 0, 5);
  assert.ok(shows.items.length, 'TV library has shows');
  const seasons = api.children(shows.items[0].ratingKey, 0, 50);
  assert.ok(seasons.items.length && seasons.items[0].type === 'season');
  const eps = api.children(seasons.items[0].ratingKey, 0, 50);
  assert.ok(eps.items.length && eps.items[0].type === 'episode');
  assert.ok(eps.items[0].Media[0].Part[0].key);
});

test('global search returns results and excludes a disabled library (plugin level)', { skip }, () => {
  const { env: e, store } = L.loadPlugin();
  try {
    const sample = api.sectionAll(largest.key, {}, 0, 1).items[0];
    const term = sample.title.split(/\s+/)[0];
    let p = e.open('plex:start');          // sets store.machineId
    p = e.open('plex:search:' + encodeURIComponent(term));
    assert.ifError(p.exception);
    const hits = p.items.filter(i => /^plex:(play|show|artist|album|season|collection):/.test(i.url));
    assert.ok(hits.length > 0, 'search "' + term + '" found items');

    const prefs = {}; prefs[String(largest.key)] = { enabled: false };
    store['libs:' + (store.machineId || 'default')] = JSON.stringify(prefs);
    p = e.open('plex:search:' + encodeURIComponent(term));
    assert.ifError(p.exception);
    const after = p.items.filter(i => /^plex:(play|show|artist|album|season|collection):/.test(i.url));
    const hubs = api.search(term, 30);
    const fromLargest = new Set();
    hubs.forEach(h => (h.Metadata || []).forEach(m => { if(String(m.librarySectionID) === String(largest.key)) fromLargest.add(String(m.ratingKey)); }));
    assert.ok(fromLargest.size > 0, 'the disabled library had matches');
    after.forEach(i => {
      const rk = (/:(\d+)$/.exec(i.url) || [])[1];
      assert.ok(!fromLargest.has(rk), 'result from disabled library leaked: ' + i.metadata.title);
    });
    assert.ok(after.length < hits.length, 'fewer results after disabling the library');
    console.log('    search hits:', hits.length, '-> after disabling library', largest.key, ':', after.length);
  } finally {
    e.cleanup();
  }
});

test('in-library search stays inside its section', { skip }, () => {
  const sample = api.sectionAll(largest.key, {}, 0, 3).items[0];
  const term = sample.title.split(/\s+/)[0];
  const r = api.sectionAll(largest.key, { title: term }, 0, 50);
  assert.ok(r && r.items.length > 0);
  // /library/sections/{id}/all items carry no librarySectionID; compare against the full listing
  const inSection = new Set(api.sectionAll(largest.key, {}, 0, 1000).items.map(m => m.ratingKey));
  r.items.forEach(m => assert.ok(inSection.has(m.ratingKey), m.title + ' is not in section ' + largest.key));
  const everywhere = api.search(term, 50).reduce((n, h) => n + (h.size || 0), 0);
  assert.ok(r.items.length <= everywhere, 'in-library search is not wider than global search');
  const { env: e } = L.loadPlugin();
  try {
    const p = e.open('plex:sectionsearch:' + largest.key + ':' + encodeURIComponent(term));
    assert.ifError(p.exception);
    const hits = p.items.filter(i => /^plex:(play|show|artist|album|season):/.test(i.url));
    assert.ok(hits.length > 0);
  } finally { e.cleanup(); }
});

test('filters: genre + unwatched is a subset of the unfiltered list', { skip: skip || (!movieSection && 'no movie library') }, () => {
  const all = api.sectionAll(movieSection.key, {}, 0, 200);
  const genres = api.filterValues(movieSection.key, 'genre');
  assert.ok(Array.isArray(genres));
  const g = genres[0];
  const params = { unwatched: 1 };
  if(g) params.genre = decodeURIComponent(String(g.key));
  const sub = api.sectionAll(movieSection.key, params, 0, 200);
  assert.ok(sub);
  assert.ok(sub.total <= all.total);
  const allKeys = new Set(all.items.map(m => m.ratingKey));
  sub.items.forEach(m => assert.ok(allKeys.has(m.ratingKey)));
  if(g) assert.ok(sub.total < all.total || all.total <= 1, 'genre filter reduced the list');
  for(const f of ['year', 'decade', 'contentRating', 'resolution', 'collection', 'actor', 'director']) {
    assert.ok(Array.isArray(api.filterValues(movieSection.key, f)), 'filter endpoint ' + f);
  }
});

test('every sort key changes the order', { skip }, () => {
  const base = api.sectionAll(largest.key, { sort: 'titleSort:asc' }, 0, 50).items.map(m => m.ratingKey).join(',');
  const changed = [];
  for(const key of ['titleSort:desc', 'addedAt:desc', 'originallyAvailableAt:asc', 'rating:desc', 'lastViewedAt:desc', 'duration:desc', 'random']) {
    const r = api.sectionAll(largest.key, { sort: key }, 0, 50);
    assert.ok(r && r.items.length, key);
    if(r.items.map(m => m.ratingKey).join(',') !== base) changed.push(key);
  }
  console.log('    sort keys that reorder this library:', changed.join(', '));
  assert.ok(changed.indexOf('titleSort:desc') !== -1 || base.indexOf(',') === -1);
  assert.ok(changed.length >= 2, 'at least two sort keys reorder');
});

test('A-Z jump returns items starting with the chosen letter', { skip }, () => {
  const chars = api.firstCharacters(largest.key);
  assert.ok(chars && chars.length);
  const c = chars.filter(x => /^[A-Z]$/.test(x.title))[0] || chars[0];
  const r = api.firstCharacterItems(largest.key, c.key, {}, 0, 50);
  assert.ok(r && r.items.length > 0, 'letter ' + c.title + ' has items');
  r.items.forEach(m => {
    const t = (m.titleSort || m.title).replace(/^(the|a|an)\s+/i, '').toUpperCase();
    if(/^[A-Z]$/.test(c.title)) assert.strictEqual(t.charAt(0), c.title, m.title);
  });
});

test('direct play: HTTP Range request for the first 64 KB answers 206/200', { skip }, () => {
  const http = env.require('movian/http');
  const found = api.sectionAll(largest.key, {}, 0, 50).items.filter(m => m.Media && m.Media[0].Part)[0];
  assert.ok(found);
  const r = http.request(api.partUrl(found.Media[0].Part[0].key), { method: 'GET', headers: { Range: 'bytes=0-65535' }, noFail: true });
  assert.ok(r.statuscode === 206 || r.statuscode === 200, 'status ' + r.statuscode);
  assert.ok(r.bytes.length >= 1024, 'got ' + r.bytes.length + ' bytes');
  if(r.statuscode === 206) assert.ok(/^bytes 0-65535\//.test(r.headers_lc['content-range']), r.headers_lc['content-range']);
});

test('transcode: HLS session yields h264 8-bit + aac, then stop', { skip }, () => {
  const decide = env.require('lib/decide');
  const http = env.require('movian/http');
  let item = null;
  for(const s of sections.filter(x => x.type === 'movie' || x.type === 'show')) {
    const r = api.sectionAll(s.key, s.type === 'show' ? { type: 4 } : {}, 0, 100);
    if(!r) continue;
    item = r.items.filter(m => m.Media && m.Media[0].videoCodec === 'hevc')[0] || item || r.items.filter(m => m.Media)[0];
    if(item && item.Media[0].videoCodec === 'hevc') break;
  }
  assert.ok(item, 'a video item exists');
  const full = api.metadata(item.ratingKey);
  const plan = decide.decide(full, { mode: full.Media[0].videoCodec === 'hevc' ? 'auto' : 'transcode', quality: 'original' });
  assert.ok(plan.transcode, 'plan is a transcode: ' + plan.reason);
  const session = 'livetest-' + Date.now();
  const startUrl = api.transcodeUrl(plan, session);
  const tok = L.PLEX_TOKEN ? '?X-Plex-Token=' + encodeURIComponent(L.PLEX_TOKEN) : '';
  const r1 = http.request(startUrl, { noFail: true });
  assert.strictEqual(r1.statuscode, 200, 'start.m3u8 -> ' + r1.statuscode);
  const master = r1.toString();
  const variant = master.split('\n').filter(l => l && l[0] !== '#')[0];
  assert.ok(variant, 'master playlist lists a variant:\n' + master);
  const base = startUrl.replace(/start\.m3u8.*$/, '');
  const r2 = http.request(base + variant + tok, { noFail: true });
  assert.strictEqual(r2.statuscode, 200, 'variant playlist');
  const index = r2.toString();
  assert.ok(/#EXT-X-ENDLIST/.test(index), 'VOD playlist (seekable): has ENDLIST');
  const seg = index.split('\n').filter(l => l && l[0] !== '#')[0];
  const segDir = variant.replace(/[^/]*$/, '');
  const r3 = http.request(base + segDir + seg + tok, { noFail: true, timeoutMs: 120000 });
  assert.strictEqual(r3.statuscode, 200, 'first segment');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plexseg-')), 'seg.ts');
  fs.writeFileSync(tmp, r3.bytes);
  const streams = L.ffprobe(tmp);
  const v = streams.filter(s => s.codec_type === 'video')[0];
  const a = streams.filter(s => s.codec_type === 'audio')[0];
  assert.ok(v && v.codec_name === 'h264', JSON.stringify(streams));
  assert.strictEqual(v.pix_fmt, 'yuv420p', '8-bit 4:2:0');
  assert.ok(v.level <= 41, 'level ' + v.level);
  assert.ok(v.height <= 1080 && v.width <= 1920);
  assert.ok(a && a.codec_name === 'aac', JSON.stringify(a));
  assert.ok(a.channels <= 2);
  const stop = api.transcodeStop(session);
  assert.ok(stop.ok, 'stop -> ' + stop.status);
  console.log('    transcode ok:', v.codec_name, v.profile, 'L' + v.level, v.width + 'x' + v.height, a.codec_name, a.channels + 'ch');
});

test('timeline: progress is stored on the server and restored afterwards', { skip }, () => {
  let best = null;
  for(const s of sections.filter(x => x.type === 'movie' || x.type === 'show')) {
    const r = api.sectionAll(s.key, s.type === 'show' ? { type: 4, sort: 'duration:desc' } : { sort: 'duration:desc' }, 0, 1);
    if(r && r.items[0] && (!best || r.items[0].duration > best.duration)) best = r.items[0];
  }
  assert.ok(best && best.duration > 120000, 'a video longer than 2 minutes exists (longest: ' + (best && best.duration) + ' ms)');
  const before = api.metadata(best.ratingKey);
  const origOffset = before.viewOffset || 0;
  const target = Math.min(Math.floor(best.duration / 2), origOffset + 90000 + 1);
  const t = api.timeline({ ratingKey: best.ratingKey, state: 'playing', timeMs: target, durationMs: best.duration, session: 'livetest' });
  assert.ok(t.ok, 'timeline -> ' + t.status);
  const after = api.metadata(best.ratingKey);
  assert.strictEqual(after.viewOffset, target, 'viewOffset updated');
  if(origOffset > 0) api.timeline({ ratingKey: best.ratingKey, state: 'stopped', timeMs: origOffset, durationMs: best.duration, session: 'livetest' });
  else api.unscrobble(best.ratingKey);
  const restored = api.metadata(best.ratingKey);
  assert.strictEqual(restored.viewOffset || 0, origOffset, 'viewOffset restored');
});
