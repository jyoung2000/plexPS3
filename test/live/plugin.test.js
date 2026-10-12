'use strict';
// The whole plugin running under the Movian shims against the live server.
const test = require('node:test');
const assert = require('node:assert');
const L = require('./_env');

const skip = L.configured ? false : 'PMS_URL not set in .env';

function sessionOf(vp) {
  const m = /[?&]session=([^&]+)/.exec(vp.sources[0].url);
  return m ? m[1] : null;
}

test('plugin: home, libraries, section, play (direct and transcode), resume dialog, tracks, search, scrobbler', { skip }, () => {
  const { env, world } = L.loadPlugin();
  const api = L.makeApi().api;
  try {
    let p = env.open('plex:start');
    assert.ifError(p.exception);
    assert.strictEqual(p.errorMsg, null);
    const titles = p.items.map(i => i.metadata.title);
    assert.ok(titles.indexOf('Search') !== -1 && titles.indexOf('Choose libraries...') !== -1, titles.join(' | '));
    const libs = p.items.filter(i => /^plex:section:\d+$/.test(i.url));
    assert.ok(libs.length > 0, 'libraries listed on home');

    p = env.open('plex:libraries');
    assert.ifError(p.exception);
    const toggles = p.items.filter(i => i.type === 'action' && /^\[x\] /.test(i.metadata.title));
    assert.ok(toggles.length >= libs.length);
    assert.ok(toggles[0].options.some(o => /Pin to home/.test(o.title)));
    assert.ok(toggles[0].options.some(o => /Move up/.test(o.title)));
    toggles[0].func();
    assert.ok(/^\[ \] /.test(toggles[0].metadata.title));
    toggles[0].func();
    assert.ok(/^\[x\] /.test(toggles[0].metadata.title));

    const movieLib = libs.filter(l => /Movies/.test(l.metadata.title))[0] || libs[0];
    const secUrl = movieLib.url;
    const secId = secUrl.split(':')[2];
    p = env.open(secUrl);
    assert.ifError(p.exception);
    assert.strictEqual(p.errorMsg, null, p.errorMsg);
    assert.ok(p.options.map(o => o.id).join(',').indexOf('sort') !== -1);
    p.drain(10);
    const videos = p.items.filter(i => i.type === 'video');
    const dirs = p.items.filter(i => /^plex:(show|artist):/.test(i.url));
    assert.ok(videos.length + dirs.length > 0, 'section lists items');
    if(videos.length) {
      assert.ok(videos[0].metadata.icon.indexOf('/photo/:/transcode?width=300') !== -1, 'pre-scaled thumbnail');
      assert.ok(videos[0].options.some(o => /1080p 12 Mbps/.test(o.title)) && videos[0].options.some(o => /Audio and subtitle/.test(o.title)));
    }

    const az = env.open('plex:az:' + secId);
    assert.ifError(az.exception);
    assert.ok(az.items.length > 0, 'A-Z letters');
    const fl = env.open('plex:filters:' + secId);
    assert.ifError(fl.exception);
    assert.ok(fl.items.some(i => /^Genre/.test(i.metadata.title)));
    const fg = env.open('plex:filter:' + secId + ':genre');
    assert.ifError(fg.exception);
    const genreChoice = fg.items.filter(i => i.type === 'action' && !/^Any /.test(i.metadata.title))[0];
    if(genreChoice) {
      genreChoice.func();
      assert.strictEqual(fg.redirectedTo, secUrl);
      const filtered = env.open(secUrl);
      assert.ifError(filtered.exception);
      assert.ok(/\[/.test(filtered.model.metadata.title), 'active filter shown in title: ' + filtered.model.metadata.title);
      const clear = filtered.items.filter(i => i.metadata.title === 'Clear filters')[0];
      assert.ok(clear, 'Clear filters entry present');
      clear.func();
    }

    const all = api.sectionAll(secId, {}, 0, 100);
    let direct = null, hevc = null;
    for(const m of all.items) {
      if(!m.Media) continue;
      if(m.Media[0].videoCodec === 'hevc') hevc = hevc || m;
      if(m.Media[0].videoCodec === 'h264' && m.Media[0].Part[0].container === 'mkv') direct = direct || m;
    }
    if(direct) {
      p = env.open('plex:play:' + direct.ratingKey);
      assert.ifError(p.exception);
      assert.strictEqual(p.model.type, 'video');
      assert.ok(/^videoparams:/.test(p.sourceUrl));
      const vp = JSON.parse(p.sourceUrl.substring(12));
      assert.ok(/^plex:play:\d+#/.test(vp.canonicalUrl));
      assert.ok(vp.sources[0].url.indexOf('/library/parts/') !== -1);
      if(L.PLEX_TOKEN) assert.ok(vp.sources[0].url.indexOf('X-Plex-Token=') !== -1);
      assert.strictEqual(vp.no_fs_scan, true);
      assert.ok(vp.subtitles.length >= 0);
      console.log('    direct play source:', vp.sources[0].mimetype, 'subtitles:', vp.subtitles.length);
    }
    if(hevc) {
      p = env.open('plex:play:' + hevc.ratingKey);
      assert.ifError(p.exception);
      const vp = JSON.parse(p.sourceUrl.substring(12));
      assert.ok(/^hls:http/.test(vp.sources[0].url), vp.sources[0].url);
      assert.ok(/transcode\/universal\/start\.m3u8/.test(vp.sources[0].url));
      api.transcodeStop(sessionOf(vp));
    }

    const longest = all.items.filter(m => m.Media && m.duration > 150000).sort((a, b) => b.duration - a.duration)[0];
    if(longest) {
      api.timeline({ ratingKey: longest.ratingKey, state: 'playing', timeMs: 120000, durationMs: longest.duration, session: 'livetest' });
      try {
        world.messageAnswer = true;   // user picks "resume"
        p = env.open('plex:play:' + longest.ratingKey);
        assert.ifError(p.exception);
        assert.ok(world.messages.some(m => /Resume/.test(m)), 'resume question asked');
        let vp = JSON.parse(p.sourceUrl.substring(12));
        assert.ok(/offset=120/.test(vp.sources[0].url), 'resumed stream starts at the offset: ' + vp.sources[0].url);
        api.transcodeStop(sessionOf(vp));

        world.messages.length = 0;
        world.messageAnswer = false;  // start over
        p = env.open('plex:play:' + longest.ratingKey);
        vp = JSON.parse(p.sourceUrl.substring(12));
        assert.ok(!/offset=120/.test(vp.sources[0].url));

        world.messages.length = 0;
        p = env.open('plex:play:' + longest.ratingKey, { sync: true }); // queue auto-advance: no dialog
        assert.strictEqual(world.messages.length, 0, 'no blocking dialog in sync mode');
        vp = JSON.parse(p.sourceUrl.substring(12));
        if(sessionOf(vp)) api.transcodeStop(sessionOf(vp));

        p = env.open('plex:play:' + longest.ratingKey + ':begin');
        vp = JSON.parse(p.sourceUrl.substring(12));
        assert.ok(!/offset=120/.test(vp.sources[0].url));

        p = env.open('plex:play:' + longest.ratingKey, { how: 'resume' });
        vp = JSON.parse(p.sourceUrl.substring(12));
        assert.ok(/offset=120/.test(vp.sources[0].url), 'how=resume resumes without asking');
        if(sessionOf(vp)) api.transcodeStop(sessionOf(vp));
      } finally {
        api.unscrobble(longest.ratingKey);
      }
    }

    if(direct) {
      p = env.open('plex:streams:' + direct.ratingKey);
      assert.ifError(p.exception);
      assert.ok(p.items.some(i => i.metadata.title === 'Audio'));
      const audio = p.items.filter(i => i.type === 'action' && /\[A/.test(i.metadata.title));
      assert.ok(audio.length >= 1, 'audio tracks listed');
    }

    world.textAnswer = 'film';
    p = env.open('plex:search');
    assert.ifError(p.exception);
    p = env.open('plex:search:film');
    assert.ifError(p.exception);
    p = env.open('plex:search');
    assert.ok(p.items.some(i => i.metadata.title === 'film'), 'recent search remembered');

    // Movian Searcher hook
    const sp = require('../shim/movian-page').newPage(world, 'search:film');
    world.searchers[0].callback(sp.api, 'film');
    assert.ok(sp.items.length > 0, 'Searcher returns items');

    // scrobbler hook: start/pause/stop report the timeline for a play-route session
    if(longest) {
      p = env.open('plex:play:' + longest.ratingKey + ':begin');
      const vp = JSON.parse(p.sourceUrl.substring(12));
      const vs = world.scrobblers[0];
      const mp = { currenttime: 95.5, playstatus: 'play' };
      vs.onstart({ canonical_url: vp.canonicalUrl, id: 'x', duration: longest.duration / 1000 }, mp, {});
      vs.onpause({ canonical_url: vp.canonicalUrl }, mp, {});
      vs.onstop({ canonical_url: vp.canonicalUrl, stopposition: 100 }, mp, {});
      const m = api.metadata(longest.ratingKey);
      assert.strictEqual(m.viewOffset, 100000, 'server viewOffset follows the stop position');
      api.unscrobble(longest.ratingKey);
      if(sessionOf(vp)) api.transcodeStop(sessionOf(vp));
    }
  } finally {
    env.cleanup();
  }
});

test('plugin: unlinked state goes to the PIN page and the PIN page fails soft', { skip }, () => {
  const { env, world } = L.loadPlugin();
  try {
    world.settings.items.serverUrl.value = '';
    world.settings.items.token.value = '';
    let p = env.open('plex:start');
    assert.strictEqual(p.redirectedTo, 'plex:link');
    p = env.open('plex:link');
    assert.ifError(p.exception);
    const t = p.items.map(i => i.metadata.title).join('\n');
    assert.ok(/plex\.tv\/link|get_token\.py/.test(t), t);
    // on-TV manual entry is always offered so the plex.tv-unreachable case never dead-ends
    assert.ok(p.items.some(i => /Enter server address on this TV/.test(i.metadata.title)), 'server-entry action present');
    assert.ok(p.items.some(i => /Enter a Plex token on this TV/.test(i.metadata.title)), 'token-entry action present');

    // drive the on-TV server entry against the live server
    world.textAnswer = L.PMS_URL;
    const serverAction = p.items.filter(i => /Enter server address on this TV/.test(i.metadata.title))[0];
    serverAction.func();
    if(L.PLEX_TOKEN) {
      // no token yet, so the server either needs auth (-> back to link) or allows this IP
      assert.ok(p.redirectedTo === 'plex:start' || p.redirectedTo === 'plex:link', 'server entry resolved: ' + p.redirectedTo);
    }
    console.log('    link page:', /get_token/.test(t) ? 'plex.tv unreachable -> helper + on-TV entry' : 'PIN code + on-TV entry');
  } finally {
    env.cleanup();
  }
});
