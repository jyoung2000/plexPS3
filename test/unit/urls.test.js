'use strict';
// URL builders in plugin/lib/plexapi.js and helpers in lib/util.js.
const test = require('node:test');
const assert = require('node:assert');

const env = require('../shim/loader').create({});
const util = env.require('lib/util');
const plexapi = env.require('lib/plexapi');

function client(server, token, httpImpl) {
  return plexapi.create({
    http: httpImpl || (() => ({ statuscode: 200, headers_lc: { 'content-type': 'application/json' }, toString: () => '{"MediaContainer":{"size":0}}' })),
    identity: { clientId: 'cid-1', product: 'Plex for Movian', version: '0.1.0', platform: 'PlayStation 3', platformVersion: '5', device: 'PlayStation 3', deviceName: 'Movian on PlayStation 3', model: 'CECH' },
    getServer: () => server,
    getToken: () => token
  });
}

test('token present, paths encoded, no double slashes', () => {
  const api = client('http://192.168.1.10:32400/', 'tok123');
  const u = api.url('/library/sections/1/all', { sort: 'titleSort:asc', title: 'a b&c' });
  assert.strictEqual(u, 'http://192.168.1.10:32400/library/sections/1/all?sort=titleSort%3Aasc&title=a%20b%26c&X-Plex-Token=tok123');
  assert.ok(!/[^:]\/\//.test(u.replace('http://', '')), 'no double slash: ' + u);
});

test('server URL normalisation (bare IP, trailing slash, missing port)', () => {
  assert.strictEqual(util.normalizeServerUrl('192.168.1.10'), 'http://192.168.1.10:32400');
  assert.strictEqual(util.normalizeServerUrl('http://192.168.1.10:32400/'), 'http://192.168.1.10:32400');
  assert.strictEqual(util.normalizeServerUrl('https://plex.example.org:443'), 'https://plex.example.org:443');
  assert.strictEqual(client('192.168.1.10', '').server(), 'http://192.168.1.10:32400');
});

test('no token -> no X-Plex-Token parameter', () => {
  const api = client('http://h:32400', '');
  assert.ok(api.url('/identity').indexOf('X-Plex-Token') === -1);
  assert.ok(!('X-Plex-Token' in api.headers()));
  assert.strictEqual(api.headers().Accept, 'application/json');
  assert.strictEqual(api.headers()['X-Plex-Client-Identifier'], 'cid-1');
});

test('thumbnail URL is pre-scaled via /photo/:/transcode and carries the token', () => {
  const api = client('http://h:32400', 't');
  const u = api.thumb('/library/metadata/1/thumb/99', 300, 450);
  assert.strictEqual(u, 'http://h:32400/photo/:/transcode?width=300&height=450&minSize=1&upscale=1&url=%2Flibrary%2Fmetadata%2F1%2Fthumb%2F99&X-Plex-Token=t');
  assert.strictEqual(api.thumb(null), null);
});

test('part and stream URLs', () => {
  const api = client('http://h:32400', 't');
  assert.strictEqual(api.partUrl('/library/parts/1/123/file.mkv'), 'http://h:32400/library/parts/1/123/file.mkv?X-Plex-Token=t');
  assert.strictEqual(api.streamUrl(4), 'http://h:32400/library/streams/4?encoding=utf-8&X-Plex-Token=t');
  assert.strictEqual(api.streamUrl(4, 'srt'), 'http://h:32400/library/streams/4?encoding=utf-8&format=srt&X-Plex-Token=t');
});

test('transcode URL carries every required parameter', () => {
  const api = client('http://h:32400', 't');
  const plan = { ratingKey: '2', mediaIndex: 0, partIndex: 0, transcode: { directStream: false, maxVideoBitrate: 8000, videoResolution: '1920x1080', burnSubtitles: true, offsetSec: 90 } };
  const u = api.transcodeUrl(plan, 'sess-1');
  const q = Object.fromEntries(new URL(u).searchParams.entries());
  assert.strictEqual(new URL(u).pathname, '/video/:/transcode/universal/start.m3u8');
  assert.strictEqual(q.path, '/library/metadata/2');
  assert.strictEqual(q.protocol, 'hls');
  assert.strictEqual(q.directPlay, '0');
  assert.strictEqual(q.directStream, '0');
  assert.strictEqual(q.fastSeek, '1');
  assert.strictEqual(q.offset, '90');
  assert.strictEqual(q.maxVideoBitrate, '8000');
  assert.strictEqual(q.videoResolution, '1920x1080');
  assert.strictEqual(q.videoQuality, '100');
  assert.strictEqual(q.subtitles, 'burn');
  assert.strictEqual(q.session, 'sess-1');
  assert.strictEqual(q['X-Plex-Token'], 't');
  assert.strictEqual(q['X-Plex-Client-Identifier'], 'cid-1');
  assert.strictEqual(q['X-Plex-Device'], 'PlayStation 3');
  assert.ok(/videoCodec=h264/.test(q['X-Plex-Client-Profile-Extra']));
  assert.ok(/audioCodec=aac/.test(q['X-Plex-Client-Profile-Extra']));
  assert.ok(/video\.level&value=41/.test(q['X-Plex-Client-Profile-Extra']));
});

test('directstream (remux) URL has no bitrate cap and directStream=1', () => {
  const api = client('http://h:32400', 't');
  const u = api.transcodeUrl({ ratingKey: '1', transcode: { directStream: true, maxVideoBitrate: 0, videoResolution: null, offsetSec: 5 } }, 's');
  const q = Object.fromEntries(new URL(u).searchParams.entries());
  assert.strictEqual(q.directStream, '1');
  assert.strictEqual(q.maxVideoBitrate, undefined);
  assert.strictEqual(q.videoResolution, undefined);
  assert.strictEqual(q.subtitles, 'none');
});

test('request never throws and redacts the token in logs', () => {
  const lines = [];
  const api = plexapi.create({
    http: () => { throw new Error('connection refused'); },
    identity: { clientId: 'c' }, getServer: () => 'http://h:32400', getToken: () => 'secret', log: l => lines.push(l)
  });
  const r = api.get('/identity');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 0);
  assert.ok(/connection refused/.test(r.error));
  assert.ok(lines.length && lines[0].indexOf('secret') === -1, lines.join('\n'));
  assert.ok(/HTTP GET http:\/\/h:32400\/identity -> ERROR/.test(lines[0]), lines[0]);
  // token in an URL (media/thumb links) is redacted when logged
  assert.strictEqual(util.redact(api.partUrl('/library/parts/1/2/file.mkv')), 'http://h:32400/library/parts/1/2/file.mkv?X-Plex-Token=***');
});

test('non-2xx with noFail is reported as status, JSON parsed when present', () => {
  const api = client('http://h:32400', 't', () => ({ statuscode: 401, headers_lc: {}, toString: () => '<html>Unauthorized</html>' }));
  const r = api.get('/library/sections');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json, null);
  assert.strictEqual(api.sections(), null);
});

test('local connection ordering prefers local plain-http LAN addresses', () => {
  const api = client('http://h:32400', 't');
  const urls = api.localHttpConnections({ connections: [
    { uri: 'https://1-2-3-4.x.plex.direct:32400', address: '1.2.3.4', port: 32400, protocol: 'https', local: false, relay: false },
    { uri: 'http://1.2.3.4:32400', address: '1.2.3.4', port: 32400, protocol: 'http', local: false, relay: false },
    { uri: 'http://192.168.1.20:32400', address: '192.168.1.20', port: 32400, protocol: 'http', local: true, relay: false },
    { uri: 'http://relay:8443', address: 'relay', port: 8443, protocol: 'http', local: false, relay: true }
  ] });
  assert.strictEqual(JSON.stringify(urls), JSON.stringify(['http://192.168.1.20:32400', 'http://1.2.3.4:32400']));
});

test('plex.tv PIN helpers parse the real response shape', () => {
  const pin = require('../fixtures/plextv_pin.json');
  let calls = 0;
  const api = client('', '', (url, ctrl) => {
    calls++;
    assert.ok(url.indexOf('https://plex.tv/api/v2/pins') === 0, url);
    if(ctrl.method === 'POST') return { statuscode: 201, headers_lc: {}, toString: () => JSON.stringify(pin) };
    return { statuscode: 200, headers_lc: {}, toString: () => JSON.stringify(Object.assign({}, pin, { authToken: 'TOKEN' })) };
  });
  const c = api.pinCreate();
  assert.deepStrictEqual([c.ok, c.code, c.id], [true, 'ABCD', 123456789]);
  const k = api.pinCheck(c.id);
  assert.strictEqual(k.authToken, 'TOKEN');
  assert.strictEqual(calls, 2);
});

test('util formatting helpers', () => {
  assert.strictEqual(util.fmtClock(125000), '02:05');
  assert.strictEqual(util.fmtClock(5425000), '1:30:25');
  assert.strictEqual(util.query({ a: 1, b: null, c: 'x y' }), 'a=1&c=x%20y');
  assert.strictEqual(util.withQuery('http://h/p?x=1', { y: 2 }), 'http://h/p?x=1&y=2');
  assert.strictEqual(util.joinUrl('http://h:1/', '/a'), 'http://h:1/a');
  assert.ok(util.isPrivateIPv4('10.1.2.3') && util.isPrivateIPv4('172.20.0.1') && !util.isPrivateIPv4('8.8.8.8'));
  assert.strictEqual(util.uuid().length, 36);
});
