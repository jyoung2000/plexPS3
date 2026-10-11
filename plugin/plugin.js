/*
 * movian-plex: Plex client plugin for Movian (API v2 / ecmascript).
 *
 * This file holds routes and UI only. HTTP lives in lib/plexapi.js, the
 * playback decision in lib/decide.js. Everything is strict ES5 (Duktape).
 *
 * Movian APIs used here are documented with source citations in
 * docs/movian-api.md.
 */
'use strict';

var page = require('movian/page');
var service = require('movian/service');
var settings = require('movian/settings');
var store = require('movian/store');
var http = require('movian/http');
var popup = require('movian/popup');          // notify
var npopup = require('native/popup');         // message, textDialog (src/ecmascript/es_misc.c)
var prop = require('movian/prop');
var videoscrobbler = require('movian/videoscrobbler');

var util = require('lib/util');
var decide = require('lib/decide');
var plexapi = require('lib/plexapi');

var manifest = util.parseJSON(Plugin.manifest) || {};
var PLUGIN_VERSION = manifest.version || '0.0.0';
var PREFIX = 'plex';
var LOGO = Plugin.path + 'logo.png';
var PAGE_SIZE = 50;
var HOME_ROW = 12;
var RESUME_MIN_MS = 60000;
var TIMELINE_INTERVAL_MS = 10000;

var isPS3 = typeof Core.storagePath === 'string' && Core.storagePath.indexOf('/dev_hdd0/') === 0;

// ---------------------------------------------------------------------------
// Persistent state (Core.storagePath/store/plex). Values are kept primitive;
// structured data is stored as JSON strings (movian/store proxies only the
// top level, res/ecmascript/modules/movian/store.js).
// ---------------------------------------------------------------------------
var st = store.create('plex');
if(!st.clientId) st.clientId = util.uuid();

function jget(key, def) {
  var v = st[key];
  if(typeof v !== 'string' || !v) return def;
  var p = util.parseJSON(v);
  return p === null ? def : p;
}
function jset(key, obj) {
  st[key] = JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Settings (Movian global settings page: Settings > Applications > Plex)
// ---------------------------------------------------------------------------
var conf = {
  serverUrl: '',
  token: '',
  playbackMode: 'auto',
  quality: 'original',
  burnSubtitles: false,
  debug: false
};

function dlog(msg) {
  if(conf.debug) console.log('[plex] ' + msg);
}
function ilog(msg) {
  console.log('[plex] ' + msg);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
var lastAuthWarning = 0;

var api = plexapi.create({
  http: function(url, ctrl, cb) {
    return http.request(url, ctrl, cb);
  },
  identity: {
    clientId: st.clientId,
    product: 'Plex for Movian',
    version: PLUGIN_VERSION,
    platform: isPS3 ? 'PlayStation 3' : 'Movian',
    platformVersion: String(Core.currentVersionString || ''),
    device: isPS3 ? 'PlayStation 3' : 'Movian',
    deviceName: isPS3 ? 'Movian on PlayStation 3' : 'Movian',
    model: isPS3 ? 'CECH' : 'desktop'
  },
  getServer: function() { return conf.serverUrl; },
  getToken: function() { return conf.token; },
  log: ilog,
  isDebug: function() { return conf.debug; },
  onStatus: function(status, url) {
    if(status === 401 && util.now() - lastAuthWarning > 30000) {
      lastAuthWarning = util.now();
      popup.notify('Plex rejected the sign-in token. Open Plex and link again, or enter a token in Settings > Plex.', 8);
    }
  }
});

var group = new settings.globalSettings(PREFIX, 'Plex', LOGO, 'Plex Media Server client');

group.createDivider('Server');
var serverSetting = group.createString('serverUrl', 'Server URL (http://ip:32400)', '', function(v) {
  conf.serverUrl = util.trim(v);
});
var tokenSetting = group.createString('token', 'Plex token (leave empty when linked with PIN)', '', function(v) {
  conf.token = util.trim(v);
});
group.createAction('link', 'Link with plex.tv (PIN)', function() {
  openUrl(PREFIX + ':link');
});
group.createAction('discover', 'Discover servers', function() {
  openUrl(PREFIX + ':servers');
});
group.createAction('libraries', 'Choose libraries', function() {
  openUrl(PREFIX + ':libraries');
});
group.createAction('signout', 'Sign out', function() {
  conf.token = '';
  tokenSetting.value = '';
  st.machineId = '';
  st.serverName = '';
  popup.notify('Signed out of Plex. Open Plex to link again.', 5);
});

group.createDivider('Playback');
group.createMultiOpt('playbackMode', 'Playback mode', [
  ['auto', 'Auto (direct play when the PS3 can decode it)', true],
  ['direct', 'Always direct play'],
  ['transcode', 'Always transcode']
], function(v) {
  conf.playbackMode = v;
});
group.createMultiOpt('quality', 'Quality', util.map(decide.QUALITIES, function(q) {
  return [q.id, q.title, q.id === 'original'];
}), function(v) {
  conf.quality = v;
});
group.createBool('burnSubtitles', 'Burn subtitles into video when transcoding', false, function(v) {
  conf.burnSubtitles = !!v;
});
group.createDivider('Advanced');
group.createBool('debug', 'Debug logging', false, function(v) {
  conf.debug = !!v;
});
group.createInfo('about', LOGO, 'movian-plex ' + PLUGIN_VERSION + ' - client id ' + st.clientId);

service.create('Plex', PREFIX + ':start', 'video', true, LOGO);

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------
function navEventSink() {
  // prop tree: global.navigators.{nodes,current} (src/navigator.c:319-322)
  var navs = prop.global.navigators;
  var sink = null;
  try { sink = navs.current.eventSink; } catch(e1) { sink = null; }
  if(!sink) {
    try { sink = navs.nodes[0].eventSink; } catch(e2) { sink = null; }
  }
  return sink;
}

function openUrl(url, how) {
  // Open a page from outside a route (settings actions, item options, timers).
  // Same mechanism Movian's itemhook module uses (modules/movian/itemhook.js:23).
  var args = { url: String(url) };
  if(how) args.how = how;
  try {
    prop.sendEvent(navEventSink(), 'openurl', args);
  } catch(e) {
    ilog('openUrl failed: ' + e);
    popup.notify('Could not open ' + url, 3);
  }
}

function settingsUrl() {
  // settings.globalSettings() sets model.url = prop.makeUrl(model) (modules/movian/settings.js:283)
  try { return String(group.properties.url); } catch(e) { return 'settings:'; }
}

function setHeader(p, title, icon) {
  p.type = 'directory';
  p.metadata.title = title;
  p.metadata.icon = icon || LOGO;
  p.metadata.logo = LOGO;
}

function fail(p, msg) {
  ilog('page error: ' + msg);
  p.error(msg);
}

function notify(msg, secs) {
  popup.notify(msg, secs || 5);
}

function askText(title, def) {
  var r = npopup.textDialog(title, true, true);
  if(!r || r.rejected) return null;
  var s = util.trim(r.input);
  return s.length ? s : (def || null);
}

function isLinked() {
  return !!(conf.serverUrl && (conf.token || st.allowNoAuth));
}

function enabledLibs() {
  return jget('libs:' + (st.machineId || 'default'), null);
}

function libPrefs() {
  // {sectionId: {enabled: bool, pinned: bool, order: n}}
  return enabledLibs() || {};
}

function saveLibPrefs(obj) {
  jset('libs:' + (st.machineId || 'default'), obj);
}

function libEnabled(prefs, key) {
  return !prefs[key] || prefs[key].enabled !== false;
}

function sectionTypeTitle(t) {
  return { movie: 'Movies', show: 'TV', artist: 'Music', photo: 'Photos' }[t] || 'Other';
}

// Sections, filtered/ordered by the user's library choices.
var sectionCache = { at: 0, list: null };
function getSections(force) {
  if(!force && sectionCache.list && util.now() - sectionCache.at < 60000) return sectionCache.list;
  var list = api.sections();
  if(list) {
    sectionCache.list = list;
    sectionCache.at = util.now();
  }
  return list;
}

function orderedSections(onlyEnabled) {
  var list = getSections() || [];
  var prefs = libPrefs();
  var out = util.filter(list, function(s) {
    if(s.type === 'photo') return false;
    return !onlyEnabled || libEnabled(prefs, s.key);
  });
  out.sort(function(a, b) {
    var pa = prefs[a.key] || {}, pb = prefs[b.key] || {};
    var ra = (pa.pinned ? 0 : 1000) + (pa.order !== undefined ? pa.order : 500);
    var rb = (pb.pinned ? 0 : 1000) + (pb.order !== undefined ? pb.order : 500);
    if(ra !== rb) return ra - rb;
    return String(a.title).localeCompare(String(b.title));
  });
  return out;
}

function enabledSectionIds() {
  var out = {};
  util.each(orderedSections(true), function(s) { out[String(s.key)] = true; });
  return out;
}

// ---------------------------------------------------------------------------
// Item rendering
// ---------------------------------------------------------------------------
function itemUrl(m) {
  switch(m.type) {
  case 'movie':
  case 'episode':
  case 'clip':
    return PREFIX + ':play:' + m.ratingKey;
  case 'show':
    return PREFIX + ':show:' + m.ratingKey;
  case 'season':
    return PREFIX + ':season:' + m.ratingKey;
  case 'artist':
    return PREFIX + ':artist:' + m.ratingKey;
  case 'album':
    return PREFIX + ':album:' + m.ratingKey;
  case 'track':
    var a = decide.decideAudio(m);
    return a ? api.partUrl(a.partKey) : '';
  case 'collection':
    return PREFIX + ':collection:' + m.ratingKey;
  default:
    return m.key ? PREFIX + ':key:' + encodeURIComponent(m.key) : '';
  }
}

function itemType(m) {
  switch(m.type) {
  case 'movie':
  case 'episode':
  case 'clip':
    return 'video';
  case 'track':
    return 'audio';
  case 'album':
    return 'album';
  case 'artist':
    return 'artist';
  default:
    return 'directory';
  }
}

function thumbFor(m) {
  var t = m.thumb || m.parentThumb || m.grandparentThumb || m.art;
  return t ? api.thumb(t, 300, 450) : LOGO;
}

function titleFor(m, ctx) {
  if(m.type === 'episode') {
    var s = m.parentIndex !== undefined ? 'S' + util.pad2(m.parentIndex) : '';
    var e = m.index !== undefined ? 'E' + util.pad2(m.index) : '';
    var pre = (ctx && ctx.inSeason) ? (e ? e + ' ' : '') : (m.grandparentTitle ? m.grandparentTitle + ' ' + s + e + ' ' : '');
    return pre + (m.title || 'Episode');
  }
  if(m.type === 'season') return m.title + (m.leafCount ? ' (' + m.leafCount + ')' : '');
  if(m.type === 'track') return (m.index ? util.pad2(m.index) + '. ' : '') + m.title;
  if(m.type === 'movie' && m.year && !(ctx && ctx.noYear)) return m.title + ' (' + m.year + ')';
  return m.title || '';
}

function metadataFor(m, ctx) {
  var md = {
    title: titleFor(m, ctx),
    icon: thumbFor(m)
  };
  if(m.summary) md.description = m.summary;
  if(m.tagline) md.tagline = m.tagline;
  if(m.duration) md.duration = m.duration / 1000;
  if(m.year) md.year = m.year;
  var rating = m.audienceRating || m.rating;
  if(rating) md.rating = Math.round(rating * 10);
  if(m.Genre && m.Genre.length) md.genre = util.map(m.Genre, function(g) { return g.tag; }).join(', ');
  if(m.type === 'episode') {
    if(m.index !== undefined) md.episode = m.index;
    if(m.parentIndex !== undefined) md.season = m.parentIndex;
  }
  if(m.type === 'track') {
    md.artist = m.grandparentTitle || m.originalTitle || '';
    md.album = m.parentTitle || '';
    if(m.index) md.track = m.index;
  }
  if(m.type === 'album' && m.parentTitle) md.artist = m.parentTitle;
  if(m.type === 'show' && m.leafCount) md.description = (m.childCount ? m.childCount + ' seasons, ' : '') + m.leafCount + ' episodes' + (m.summary ? '\n' + m.summary : '');
  return md;
}

// Append one Plex item to a page with watched/progress state and options.
function appendPlexItem(p, m, ctx) {
  var url = itemUrl(m);
  if(!url) return null;
  var type = itemType(m);
  var item = p.appendItem(url, type, metadataFor(m, ctx));
  if(type === 'video') {
    // Skin reads $self.playcount and $self.restartpos (glwskins/flat/items/list/video.view)
    if(m.viewCount) item.root.playcount = util.toInt(m.viewCount, 0);
    if(m.viewOffset) item.root.restartpos = util.toInt(m.viewOffset, 0) / 1000;
    addVideoOptions(item, m);
  }
  return item;
}

function addVideoOptions(item, m) {
  var rk = m.ratingKey;
  item.addOptAction('Play from beginning', function() {
    openUrl(PREFIX + ':play:' + rk + ':begin');
  }, 'play');
  if(m.viewOffset > RESUME_MIN_MS) {
    item.addOptAction('Resume from ' + util.fmtClock(m.viewOffset), function() {
      openUrl(PREFIX + ':play:' + rk + ':resume');
    }, 'play');
  }
  item.addOptSeparator('Quality');
  util.each(decide.QUALITIES, function(q) {
    item.addOptAction(q.title, function() {
      openUrl(PREFIX + ':play:' + rk + ':q:' + q.id);
    }, 'quality');
  });
  item.addOptSeparator('Tracks');
  item.addOptAction('Audio and subtitle tracks...', function() {
    openUrl(PREFIX + ':streams:' + rk);
  }, 'tracks');
  item.addOptSeparator('Watched state');
  item.addOptAction('Mark as watched', function() {
    api.scrobble(rk);
    item.root.playcount = 1;
    item.root.restartpos = 0;
    notify('Marked as watched', 2);
  }, 'watched');
  item.addOptAction('Mark as unwatched', function() {
    api.unscrobble(rk);
    item.root.playcount = 0;
    item.root.restartpos = 0;
    notify('Marked as unwatched', 2);
  }, 'unwatched');
}

function appendItems(p, items, ctx) {
  var n = 0;
  util.each(items, function(m) {
    if(appendPlexItem(p, m, ctx)) n++;
  });
  return n;
}

/**
 * Standard paged listing. fetch(start, size) must return {items, total} or null.
 */
function paged(p, fetch, ctx) {
  var offset = 0;
  var total = -1;
  function more() {
    var res = fetch(offset, PAGE_SIZE);
    if(!res) {
      if(offset === 0) fail(p, 'Plex server did not answer: ' + (api.lastError || 'unknown error'));
      return false;
    }
    appendItems(p, res.items, ctx);
    offset += res.items.length;
    total = res.total;
    p.entries = total;
    return res.items.length > 0 && offset < total;
  }
  var haveMore = more();
  p.paginator = function() { return more(); };
  p.haveMore(haveMore);
  p.loading = false;
  return offset;
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------
function requireAuth(p) {
  if(isLinked()) return true;
  // Server URL set but no token: maybe the PS3's IP is allowed without auth.
  if(conf.serverUrl && !conf.token) {
    var v = api.validate();
    if(v.ok) {
      st.allowNoAuth = true;
      st.machineId = v.machineIdentifier || '';
      return true;
    }
  }
  p.redirect(PREFIX + ':link');
  return false;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
new page.Route(PREFIX + ':start', function(p) {
  setHeader(p, 'Plex' + (st.serverName ? ' - ' + st.serverName : ''));
  p.loading = true;
  if(!requireAuth(p)) return;

  var v = api.validate();
  if(!v.ok) {
    if(v.status === 401) {
      p.appendAction('Plex rejected the token. Link again with plex.tv (PIN)', function() { openUrl(PREFIX + ':link'); });
      p.appendAction('Enter a token manually (Settings > Plex)', function() { openUrl(settingsUrl()); });
      p.loading = false;
      return;
    }
    fail(p, 'Cannot reach the Plex server at ' + conf.serverUrl + ' (' + (v.error || 'no answer') + '). Check the server is on and the URL in Settings > Plex.');
    return;
  }
  if(v.machineIdentifier && st.machineId !== v.machineIdentifier) {
    st.machineId = v.machineIdentifier;
    sectionCache.list = null;
  }
  if(v.name) st.serverName = v.name;
  if(!st.librariesShown) {
    st.librariesShown = true;
    p.redirect(PREFIX + ':libraries:first');
    return;
  }

  p.appendItem(PREFIX + ':search', 'search', { title: 'Search', icon: LOGO });

  var enabled = enabledSectionIds();
  var anyEnabled = false;
  for(var k in enabled) if(enabled[k]) { anyEnabled = true; break; }

  var cw = util.filter(api.continueWatching(), function(m) { return enabled[String(m.librarySectionID)]; });
  if(!cw.length) {
    var od = api.onDeck(HOME_ROW);
    if(od) cw = util.filter(od.items, function(m) { return enabled[String(m.librarySectionID)]; });
  }
  if(cw.length) {
    p.appendItem(PREFIX + ':continue', 'directory', { title: 'Continue watching', icon: LOGO });
    appendItems(p, cw.slice(0, HOME_ROW));
  }

  var ra = api.recentlyAdded(HOME_ROW * 3);
  if(ra) {
    var recent = util.filter(ra.items, function(m) { return enabled[String(m.librarySectionID)]; }).slice(0, HOME_ROW);
    if(recent.length) {
      p.appendItem(PREFIX + ':recent', 'directory', { title: 'Recently added', icon: LOGO });
      appendItems(p, recent);
    }
  }

  p.appendItem('', 'separator', { title: 'Libraries' });
  util.each(orderedSections(true), function(s) {
    p.appendItem(PREFIX + ':section:' + s.key, 'directory', {
      title: s.title,
      icon: s.thumb ? api.url(s.thumb) : LOGO,
      description: sectionTypeTitle(s.type)
    });
  });
  if(!anyEnabled) p.appendPassiveItem('directory', '', { title: 'No libraries enabled' });
  p.appendItem(PREFIX + ':libraries', 'directory', { title: 'Choose libraries...', icon: LOGO });
  p.appendItem(settingsUrl(), 'directory', { title: 'Plex settings', icon: LOGO });
  p.loading = false;
});

new page.Route(PREFIX + ':continue', function(p) {
  setHeader(p, 'Continue watching');
  if(!requireAuth(p)) return;
  var enabled = enabledSectionIds();
  var items = util.filter(api.continueWatching(), function(m) { return enabled[String(m.librarySectionID)]; });
  if(!items.length) {
    var od = api.onDeck(PAGE_SIZE);
    items = od ? util.filter(od.items, function(m) { return enabled[String(m.librarySectionID)]; }) : [];
  }
  if(!appendItems(p, items)) p.appendPassiveItem('directory', '', { title: 'Nothing in progress' });
  p.loading = false;
});

new page.Route(PREFIX + ':recent', function(p) {
  setHeader(p, 'Recently added');
  if(!requireAuth(p)) return;
  var enabled = enabledSectionIds();
  paged(p, function(start, size) {
    var r = api.recentlyAdded(size, start);
    if(!r) return null;
    return { items: util.filter(r.items, function(m) { return enabled[String(m.librarySectionID)]; }), total: r.total };
  });
});

// ---------------------------------------------------------------------------
// Library sections: sort, filters, A-Z, in-library search
// ---------------------------------------------------------------------------
var SORTS = [
  ['titleSort', 'Title'],
  ['addedAt', 'Date added'],
  ['originallyAvailableAt', 'Release date'],
  ['rating', 'Rating'],
  ['lastViewedAt', 'Last played'],
  ['duration', 'Duration'],
  ['random', 'Random']
];
var FILTERS = [
  ['genre', 'Genre'],
  ['year', 'Year'],
  ['decade', 'Decade'],
  ['contentRating', 'Content rating'],
  ['resolution', 'Resolution'],
  ['collection', 'Collection'],
  ['actor', 'Actor'],
  ['director', 'Director']
];
var DEFAULT_DESC = { addedAt: true, originallyAvailableAt: true, rating: true, lastViewedAt: true };

function sectionById(id) {
  var list = getSections() || [];
  for(var i = 0; i < list.length; i++) if(String(list[i].key) === String(id)) return list[i];
  return null;
}

// Per-library view state: {sort, desc, unwatched, inProgress, filters: {genre: {key, title}}}
function viewState(sectionId) {
  return jget('view:' + sectionId, { sort: 'titleSort', desc: false, unwatched: false, inProgress: false, filters: {} });
}
function saveViewState(sectionId, vs) {
  jset('view:' + sectionId, vs);
}

function queryFor(vs, section) {
  var q = {};
  var sort = vs.sort || 'titleSort';
  if(sort !== 'random') q.sort = sort + ':' + (vs.desc ? 'desc' : 'asc');
  else q.sort = 'random';
  if(vs.unwatched) q.unwatched = 1;
  if(vs.inProgress) q.inProgress = 1;
  for(var f in vs.filters) if(vs.filters[f] && vs.filters[f].key !== undefined) q[f] = vs.filters[f].key;
  return q;
}

function filterSummary(vs) {
  var parts = [];
  for(var f in vs.filters) if(vs.filters[f]) parts.push(vs.filters[f].title);
  if(vs.unwatched) parts.push('Unwatched');
  if(vs.inProgress) parts.push('In progress');
  return parts.join(', ');
}

function sectionTitle(section, vs) {
  var t = section.title;
  var fs = filterSummary(vs);
  return fs ? t + ' [' + fs + ']' : t;
}

function listSection(p, section, extraQuery, titleOverride) {
  var vs = viewState(section.key);
  setHeader(p, titleOverride || sectionTitle(section, vs), section.thumb ? api.url(section.thumb) : LOGO);
  var q = util.extend(queryFor(vs, section), extraQuery);
  var ctx = { noYear: false };
  var fetch;
  if(section.type === 'show' && extraQuery && extraQuery.title) {
    // Show libraries: match both series and episode titles.
    fetch = function(start, size) {
      var shows = api.sectionAll(section.key, util.extend({}, q, { type: 2 }), start, size);
      var eps = api.sectionAll(section.key, util.extend({}, q, { type: 4 }), start, size);
      if(!shows && !eps) return null;
      var items = (shows ? shows.items : []).concat(eps ? eps.items : []);
      return { items: items, total: (shows ? shows.total : 0) + (eps ? eps.total : 0) };
    };
  } else {
    fetch = function(start, size) {
      return api.sectionAll(section.key, q, start, size);
    };
  }
  return paged(p, fetch, ctx);
}

function sectionOptions(p, section) {
  var vs = viewState(section.key);
  var sortOpts = util.map(SORTS, function(s) { return [s[0], s[1], s[0] === vs.sort]; });
  var dirty = false;
  p.options.createMultiOpt('sort', 'Sort by', sortOpts, function(v) {
    if(v === vs.sort) return;
    vs.sort = v;
    vs.desc = !!DEFAULT_DESC[v];
    saveViewState(section.key, vs);
    if(dirty) p.redirect(PREFIX + ':section:' + section.key);
  });
  p.options.createMultiOpt('dir', 'Order', [['asc', 'Ascending', !vs.desc], ['desc', 'Descending', !!vs.desc]], function(v) {
    var d = v === 'desc';
    if(d === !!vs.desc) return;
    vs.desc = d;
    saveViewState(section.key, vs);
    if(dirty) p.redirect(PREFIX + ':section:' + section.key);
  });
  p.options.createBool('unwatched', 'Unwatched only', !!vs.unwatched, function(v) {
    if(!!v === !!vs.unwatched) return;
    vs.unwatched = !!v;
    saveViewState(section.key, vs);
    if(dirty) p.redirect(PREFIX + ':section:' + section.key);
  });
  p.options.createBool('inprogress', 'In progress only', !!vs.inProgress, function(v) {
    if(!!v === !!vs.inProgress) return;
    vs.inProgress = !!v;
    saveViewState(section.key, vs);
    if(dirty) p.redirect(PREFIX + ':section:' + section.key);
  });
  p.options.createAction('filters', 'Filter...', function() {
    openUrl(PREFIX + ':filters:' + section.key);
  });
  p.options.createAction('clear', 'Clear filters', function() {
    vs.filters = {};
    vs.unwatched = false;
    vs.inProgress = false;
    saveViewState(section.key, vs);
    p.redirect(PREFIX + ':section:' + section.key);
  });
  // Callbacks fire once with the initial value while being created; only
  // react to real user changes after that.
  dirty = true;
}

new page.Route(PREFIX + ':section:([0-9]+)$', function(p, id) {
  if(!requireAuth(p)) return;
  var section = sectionById(id);
  if(!section) return fail(p, 'Library ' + id + ' not found on the server');
  var vs = viewState(id);
  setHeader(p, sectionTitle(section, vs));
  sectionOptions(p, section);
  p.appendItem(PREFIX + ':sectionsearch:' + id, 'search', { title: 'Search this library', icon: LOGO });
  if(section.type !== 'artist')
    p.appendItem(PREFIX + ':az:' + id, 'directory', { title: 'A-Z', icon: LOGO });
  p.appendItem(PREFIX + ':filters:' + id, 'directory', { title: 'Filter' + (filterSummary(vs) ? ': ' + filterSummary(vs) : '...'), icon: LOGO });
  if(filterSummary(vs))
    p.appendAction('Clear filters', function() {
      vs.filters = {};
      vs.unwatched = false;
      vs.inProgress = false;
      saveViewState(id, vs);
      p.redirect(PREFIX + ':section:' + id);
    });
  p.appendItem('', 'separator', { title: sectionTypeTitle(section.type) });
  listSection(p, section, {});
});

new page.Route(PREFIX + ':sectionsearch:([0-9]+)$', function(p, id) {
  if(!requireAuth(p)) return;
  var section = sectionById(id);
  if(!section) return fail(p, 'Library not found');
  var q = askText('Search ' + section.title, null);
  if(!q) {
    p.redirect(PREFIX + ':section:' + id);
    return;
  }
  rememberSearch(q);
  p.redirect(PREFIX + ':sectionsearch:' + id + ':' + encodeURIComponent(q));
});

new page.Route(PREFIX + ':sectionsearch:([0-9]+):(.+)$', function(p, id, q) {
  if(!requireAuth(p)) return;
  var section = sectionById(id);
  if(!section) return fail(p, 'Library not found');
  q = decodeURIComponent(q);
  var n = listSection(p, section, { title: q }, section.title + ': "' + q + '"');
  if(!n) p.appendPassiveItem('directory', '', { title: 'No matches for "' + q + '" in ' + section.title });
});

new page.Route(PREFIX + ':az:([0-9]+)$', function(p, id) {
  if(!requireAuth(p)) return;
  var section = sectionById(id);
  if(!section) return fail(p, 'Library not found');
  setHeader(p, section.title + ' A-Z');
  var chars = api.firstCharacters(id);
  if(!chars) return fail(p, 'Plex did not answer: ' + api.lastError);
  util.each(chars, function(c) {
    p.appendItem(PREFIX + ':az:' + id + ':' + encodeURIComponent(c.key), 'directory', {
      title: c.title + '  (' + (c.size || 0) + ')'
    });
  });
  p.loading = false;
});

new page.Route(PREFIX + ':az:([0-9]+):(.+)$', function(p, id, ch) {
  if(!requireAuth(p)) return;
  var section = sectionById(id);
  if(!section) return fail(p, 'Library not found');
  ch = decodeURIComponent(ch);
  setHeader(p, section.title + ': ' + (ch === '%23' ? '#' : ch));
  var vs = viewState(id);
  var q = queryFor(vs, section);
  paged(p, function(start, size) {
    return api.firstCharacterItems(id, ch, q, start, size);
  });
});

new page.Route(PREFIX + ':filters:([0-9]+)$', function(p, id) {
  if(!requireAuth(p)) return;
  var section = sectionById(id);
  if(!section) return fail(p, 'Library not found');
  var vs = viewState(id);
  setHeader(p, 'Filter ' + section.title);
  util.each(FILTERS, function(f) {
    if(section.type === 'artist' && (f[0] === 'resolution' || f[0] === 'actor' || f[0] === 'director' || f[0] === 'contentRating')) return;
    var cur = vs.filters[f[0]];
    p.appendItem(PREFIX + ':filter:' + id + ':' + f[0], 'directory', {
      title: f[1] + (cur ? ': ' + cur.title : ''),
      icon: LOGO
    });
  });
  p.appendAction((vs.unwatched ? '[x] ' : '[ ] ') + 'Unwatched only', function() {
    vs.unwatched = !vs.unwatched;
    saveViewState(id, vs);
    p.redirect(PREFIX + ':filters:' + id);
  });
  p.appendAction((vs.inProgress ? '[x] ' : '[ ] ') + 'In progress only', function() {
    vs.inProgress = !vs.inProgress;
    saveViewState(id, vs);
    p.redirect(PREFIX + ':filters:' + id);
  });
  p.appendAction('Show results' + (filterSummary(vs) ? ' (' + filterSummary(vs) + ')' : ''), function() {
    p.redirect(PREFIX + ':section:' + id);
  });
  p.appendAction('Clear all filters', function() {
    vs.filters = {};
    vs.unwatched = false;
    vs.inProgress = false;
    saveViewState(id, vs);
    p.redirect(PREFIX + ':section:' + id);
  });
  p.loading = false;
});

new page.Route(PREFIX + ':filter:([0-9]+):([a-zA-Z]+)$', function(p, id, name) {
  if(!requireAuth(p)) return;
  var section = sectionById(id);
  if(!section) return fail(p, 'Library not found');
  var vs = viewState(id);
  var label = name;
  util.each(FILTERS, function(f) { if(f[0] === name) label = f[1]; });
  setHeader(p, label);
  var values = api.filterValues(id, name);
  if(!values) return fail(p, 'Plex did not answer: ' + api.lastError);
  p.appendAction('Any ' + label.toLowerCase(), function() {
    delete vs.filters[name];
    saveViewState(id, vs);
    p.redirect(PREFIX + ':section:' + id);
  });
  if(!values.length) p.appendPassiveItem('directory', '', { title: 'No values for ' + label.toLowerCase() + ' in this library' });
  util.each(values, function(v) {
    var k = v.key !== undefined ? v.key : v.title;
    // Plex returns pre-escaped keys (e.g. "Not%20Rated"); send them back as-is.
    try { k = decodeURIComponent(String(k)); } catch(e) {}
    p.appendAction(v.title + (v.size ? '  (' + v.size + ')' : ''), function() {
      vs.filters[name] = { key: k, title: v.title };
      saveViewState(id, vs);
      p.redirect(PREFIX + ':section:' + id);
    });
  });
  p.loading = false;
});

// ---------------------------------------------------------------------------
// Shows, seasons, music, collections
// ---------------------------------------------------------------------------
new page.Route(PREFIX + ':show:([0-9]+)$', function(p, rk) {
  if(!requireAuth(p)) return;
  var show = api.metadata(rk);
  if(!show) return fail(p, 'Show not found: ' + api.lastError);
  setHeader(p, show.title, thumbFor(show));
  if(show.summary) p.metadata.description = show.summary;
  var ch = api.children(rk, 0, PAGE_SIZE);
  if(!ch) return fail(p, 'Plex did not answer: ' + api.lastError);
  if(ch.items.length === 1 && ch.items[0].type === 'season') {
    p.redirect(PREFIX + ':season:' + ch.items[0].ratingKey);
    return;
  }
  appendItems(p, ch.items);
  p.loading = false;
});

new page.Route(PREFIX + ':season:([0-9]+)$', function(p, rk) {
  if(!requireAuth(p)) return;
  var season = api.metadata(rk);
  if(!season) return fail(p, 'Season not found: ' + api.lastError);
  setHeader(p, (season.parentTitle ? season.parentTitle + ' - ' : '') + season.title, thumbFor(season));
  paged(p, function(start, size) {
    return api.children(rk, start, size);
  }, { inSeason: true });
});

new page.Route(PREFIX + ':artist:([0-9]+)$', function(p, rk) {
  if(!requireAuth(p)) return;
  var artist = api.metadata(rk);
  if(!artist) return fail(p, 'Artist not found: ' + api.lastError);
  setHeader(p, artist.title, thumbFor(artist));
  p.model.contents = 'albums';
  paged(p, function(start, size) {
    return api.children(rk, start, size);
  });
});

new page.Route(PREFIX + ':album:([0-9]+)$', function(p, rk) {
  if(!requireAuth(p)) return;
  var album = api.metadata(rk);
  if(!album) return fail(p, 'Album not found: ' + api.lastError);
  setHeader(p, (album.parentTitle ? album.parentTitle + ' - ' : '') + album.title, thumbFor(album));
  p.model.contents = 'album';
  paged(p, function(start, size) {
    return api.children(rk, start, size);
  });
});

new page.Route(PREFIX + ':collection:([0-9]+)$', function(p, rk) {
  if(!requireAuth(p)) return;
  var col = api.metadata(rk);
  setHeader(p, col ? col.title : 'Collection', col ? thumbFor(col) : LOGO);
  paged(p, function(start, size) {
    return api.children(rk, start, size);
  });
});

// Generic container by Plex key (hubs "more", unknown directory types)
new page.Route(PREFIX + ':key:(.+)$', function(p, key) {
  if(!requireAuth(p)) return;
  key = decodeURIComponent(key);
  setHeader(p, 'Plex');
  paged(p, function(start, size) {
    return api.page(key, {}, start, size);
  });
});

// ---------------------------------------------------------------------------
// Library selection
// ---------------------------------------------------------------------------
function librariesPage(p, first) {
  if(!requireAuth(p)) return;
  setHeader(p, first ? 'Choose the libraries to show' : 'Libraries');
  var list = getSections(true);
  if(!list) return fail(p, 'Plex did not answer: ' + api.lastError);
  var prefs = libPrefs();
  var typeFilter = st.libTypeFilter || 'all';
  var nameFilter = st.libNameFilter || '';

  p.options.createMultiOpt('libtype', 'Show type', [
    ['all', 'All', typeFilter === 'all'], ['movie', 'Movies', typeFilter === 'movie'],
    ['show', 'TV', typeFilter === 'show'], ['artist', 'Music', typeFilter === 'artist'],
    ['other', 'Other', typeFilter === 'other']
  ], function(v) {
    if(v === typeFilter) return;
    st.libTypeFilter = v;
    p.redirect(PREFIX + ':libraries');
  });
  p.options.createAction('libname', 'Filter by name...', function() {
    var q = askText('Library name contains', null);
    st.libNameFilter = q || '';
    openUrl(PREFIX + ':libraries');
  });

  if(first) {
    p.appendPassiveItem('directory', '', { title: 'All libraries are on by default. Press X to toggle one, Square for more options.' });
  }
  p.appendAction('Done - open Plex home', function() {
    p.redirect(PREFIX + ':start');
  });
  if(list.length > 6 || nameFilter) {
    p.appendAction('Name filter: ' + (nameFilter ? '"' + nameFilter + '" (press to change)' : 'none (press to set)'), function() {
      var q = askText('Library name contains', null);
      st.libNameFilter = q || '';
      p.redirect(PREFIX + ':libraries');
    });
  }
  p.appendItem('', 'separator', { title: 'Libraries' });

  var shown = orderedSections(false);
  util.each(shown, function(s) {
    var key = String(s.key);
    if(typeFilter !== 'all') {
      var isOther = s.type !== 'movie' && s.type !== 'show' && s.type !== 'artist';
      if(typeFilter === 'other' ? !isOther : s.type !== typeFilter) return;
    }
    if(nameFilter && String(s.title).toLowerCase().indexOf(nameFilter.toLowerCase()) === -1) return;
    var pr = prefs[key] || {};
    var count = s.count !== undefined ? s.count : '';
    function label() {
      return (libEnabled(prefs, key) ? '[x] ' : '[ ] ') + (pr.pinned ? '* ' : '') + s.title +
        '  - ' + sectionTypeTitle(s.type) + (count !== '' ? ', ' + count + ' items' : '');
    }
    var item = p.appendAction(label(), function() {
      pr.enabled = !libEnabled(prefs, key);
      prefs[key] = pr;
      saveLibPrefs(prefs);
      item.root.metadata.title = label();
    });
    item.addOptAction(pr.pinned ? 'Unpin from home' : 'Pin to home', function() {
      pr.pinned = !pr.pinned;
      prefs[key] = pr;
      saveLibPrefs(prefs);
      item.root.metadata.title = label();
    });
    item.addOptAction('Move up', function() {
      reorder(prefs, shown, key, -1);
      p.redirect(PREFIX + ':libraries');
    });
    item.addOptAction('Move down', function() {
      reorder(prefs, shown, key, 1);
      p.redirect(PREFIX + ':libraries');
    });
    item.addOptAction('Open library', function() {
      openUrl(PREFIX + ':section:' + key);
    });
  });
  p.loading = false;
}

function reorder(prefs, shown, key, dir) {
  var idx = -1;
  for(var i = 0; i < shown.length; i++) if(String(shown[i].key) === key) idx = i;
  var j = idx + dir;
  if(idx < 0 || j < 0 || j >= shown.length) return;
  var tmp = shown[idx];
  shown[idx] = shown[j];
  shown[j] = tmp;
  for(var n = 0; n < shown.length; n++) {
    var k = String(shown[n].key);
    prefs[k] = prefs[k] || {};
    prefs[k].order = n;
  }
  saveLibPrefs(prefs);
}

new page.Route(PREFIX + ':libraries$', function(p) { librariesPage(p, false); });
new page.Route(PREFIX + ':libraries:first$', function(p) { librariesPage(p, true); });

// ---------------------------------------------------------------------------
// Linking with plex.tv (PIN) and server discovery
// ---------------------------------------------------------------------------
function tokenHelpItems(p, reason) {
  p.appendPassiveItem('directory', '', { title: 'plex.tv could not be reached from this device' + (reason ? ' (' + reason + ')' : '') });
  p.appendPassiveItem('directory', '', { title: 'On your PC run:  python tools/get_token.py' });
  p.appendPassiveItem('directory', '', { title: 'then enter the printed token and your server address in Settings > Plex' });
  p.appendAction('Open Plex settings', function() { openUrl(settingsUrl()); });
  p.appendAction('Try again', function() { p.redirect(PREFIX + ':link'); });
}

new page.Route(PREFIX + ':link$', function(p) {
  setHeader(p, 'Link Movian with your Plex account');
  p.loading = true;

  var pin = api.pinCreate();
  if(!pin.ok) {
    tokenHelpItems(p, pin.error);
    p.loading = false;
    return;
  }

  var codeItem = p.appendPassiveItem('directory', '', { title: pin.code.split('').join(' '), icon: LOGO });
  p.appendPassiveItem('directory', '', { title: '1. On your phone or PC go to  plex.tv/link' });
  p.appendPassiveItem('directory', '', { title: '2. Sign in and type the code:  ' + pin.code });
  var status = p.appendPassiveItem('directory', '', { title: 'Waiting for the code... (' + util.fmtClock(pin.expiresIn * 1000) + ' left)' });
  p.appendAction('Enter a token manually instead (Settings > Plex)', function() { openUrl(settingsUrl()); });
  p.appendAction('Cancel', function() { p.redirect(PREFIX + ':start'); });
  p.loading = false;

  var started = util.now();
  var expiresAt = started + pin.expiresIn * 1000;
  var deadline = started + 5 * 60 * 1000;
  var pinId = pin.id;
  var pinCode = pin.code;

  function setStatus(s) {
    try { status.root.metadata.title = s; } catch(e) {}
  }

  function poll() {
    if(prop.isZombie(p.root)) return; // page closed
    var now = util.now();
    if(now > expiresAt - 5000) {
      // Code expired: get a fresh one and keep going
      var np = api.pinCreate();
      if(np.ok) {
        pinId = np.id;
        pinCode = np.code;
        expiresAt = util.now() + np.expiresIn * 1000;
        try { codeItem.root.metadata.title = np.code.split('').join(' '); } catch(e) {}
        setStatus('New code: ' + np.code + ' - enter it at plex.tv/link');
      }
    }
    if(now > deadline) {
      setStatus('No link after 5 minutes. Press Try again or use the PC token helper.');
      p.appendAction('Try again', function() { p.redirect(PREFIX + ':link'); });
      return;
    }
    var r = api.pinCheck(pinId);
    if(r.ok && r.authToken) {
      setStatus('Linked! Looking for your Plex server...');
      onLinked(p, r.authToken);
      return;
    }
    if(!r.ok && r.status === 0) {
      setStatus('plex.tv unreachable (' + (r.error || 'network') + '), retrying...');
    } else {
      setStatus('Waiting for code ' + pinCode + '... (' + util.fmtClock(Math.max(0, expiresAt - now)) + ' left)');
    }
    setTimeout(poll, 2000);
  }
  setTimeout(poll, 2000);
});

function onLinked(p, token) {
  conf.token = token;
  tokenSetting.value = token;
  st.allowNoAuth = false;
  st.librariesShown = false;
  var u = api.user(token);
  if(u && u.username) notify('Signed in to Plex as ' + u.username, 4);
  discoverAndSelect(p, token);
}

function discoverAndSelect(p, token) {
  var servers = api.resources(token);
  if(servers === null) {
    p.flush();
    tokenHelpItems(p, 'server list unavailable');
    return;
  }
  if(!servers.length) {
    p.flush();
    p.appendPassiveItem('directory', '', { title: 'No Plex Media Server is shared with this account.' });
    p.appendAction('Set a server URL manually (Settings > Plex)', function() { openUrl(settingsUrl()); });
    return;
  }
  if(servers.length === 1) {
    selectServer(p, servers[0]);
    return;
  }
  p.flush();
  setHeader(p, 'Choose a Plex server');
  util.each(servers, function(s) {
    var conns = api.localHttpConnections(s);
    p.appendAction(s.name + (s.owned ? '' : ' (shared)') + (conns.length ? '  ' + conns[0] : ''), function() {
      selectServer(p, s);
    });
  });
  p.loading = false;
}

function selectServer(p, resource) {
  var urls = api.localHttpConnections(resource);
  var serverToken = resource.accessToken || conf.token;
  p.flush();
  setHeader(p, 'Connecting to ' + resource.name);
  var status = p.appendPassiveItem('directory', '', { title: 'Probing ' + urls.length + ' address' + (urls.length === 1 ? '' : 'es') + '...' });
  if(!urls.length) {
    status.root.metadata.title = 'The server lists no HTTP LAN address. Set Plex > Settings > Network > Secure connections = Preferred.';
    p.appendAction('Enter the server URL manually (Settings > Plex)', function() { openUrl(settingsUrl()); });
    p.loading = false;
    return;
  }
  api.probe(urls, 6000, function(url, ident) {
    if(prop.isZombie(p.root)) return;
    if(!url) {
      status.root.metadata.title = 'No address answered within 6 s: ' + urls.join(', ');
      util.each(urls, function(u) {
        p.appendAction('Use ' + u + ' anyway', function() { finishServer(p, u, resource, serverToken); });
      });
      p.appendAction('Enter the server URL manually (Settings > Plex)', function() { openUrl(settingsUrl()); });
      p.loading = false;
      return;
    }
    finishServer(p, url, resource, serverToken);
  });
}

function finishServer(p, url, resource, serverToken) {
  conf.serverUrl = url;
  serverSetting.value = url;
  if(serverToken && serverToken !== conf.token) {
    // Shared servers use a per-server access token.
    conf.token = serverToken;
    tokenSetting.value = serverToken;
  }
  st.machineId = resource.clientIdentifier || '';
  st.serverName = resource.name || '';
  sectionCache.list = null;
  notify('Connected to ' + resource.name + ' at ' + url, 4);
  p.redirect(PREFIX + ':start');
}

new page.Route(PREFIX + ':servers$', function(p) {
  setHeader(p, 'Plex servers');
  if(!conf.token) {
    p.appendPassiveItem('directory', '', { title: 'Link with plex.tv first (Settings > Plex > Link with plex.tv).' });
    p.appendAction('Link now', function() { p.redirect(PREFIX + ':link'); });
    p.loading = false;
    return;
  }
  discoverAndSelect(p, conf.token);
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
var HUB_ORDER = ['movie', 'show', 'episode', 'artist', 'album', 'track', 'actor', 'director', 'collection'];
var HUB_TITLES = { movie: 'Movies', show: 'Shows', episode: 'Episodes', artist: 'Artists', album: 'Albums',
                   track: 'Tracks', actor: 'People', director: 'People', collection: 'Collections' };

function recentSearches() {
  return jget('recentSearches', []);
}
function rememberSearch(q) {
  var list = util.filter(recentSearches(), function(x) { return x !== q; });
  list.unshift(q);
  jset('recentSearches', list.slice(0, 10));
}

function hubHasEnabled(hub, enabled) {
  var items = util.filter(hub.Metadata || [], function(m) {
    return !m.librarySectionID || enabled[String(m.librarySectionID)];
  });
  return items;
}

function renderSearch(p, q, limit) {
  var enabled = enabledSectionIds();
  var hubs = api.search(q, limit || 30);
  if(!hubs) return fail(p, 'Plex search failed: ' + api.lastError);
  var shown = 0;
  var byType = {};
  util.each(hubs, function(h) { byType[h.type] = h; });
  util.each(HUB_ORDER, function(t) {
    var h = byType[t];
    if(!h || !h.size) return;
    var items = hubHasEnabled(h, enabled);
    if(!items.length) return;
    p.appendItem('', 'separator', { title: HUB_TITLES[t] || h.title });
    shown += appendItems(p, items, {});
    if(h.more || items.length >= (limit || 30)) {
      p.appendItem(PREFIX + ':searchall:' + t + ':' + encodeURIComponent(q), 'directory', { title: 'Show all ' + (HUB_TITLES[t] || h.title).toLowerCase() + ' matching "' + q + '"', icon: LOGO });
    }
  });
  return shown;
}

new page.Route(PREFIX + ':search$', function(p) {
  if(!requireAuth(p)) return;
  setHeader(p, 'Search Plex');
  p.appendAction('New search...', function() {
    var q = askText('Search Plex', null);
    if(!q) return;
    rememberSearch(q);
    p.redirect(PREFIX + ':search:' + encodeURIComponent(q));
  });
  var recent = recentSearches();
  if(recent.length) {
    p.appendItem('', 'separator', { title: 'Recent searches' });
    util.each(recent, function(q) {
      p.appendItem(PREFIX + ':search:' + encodeURIComponent(q), 'directory', { title: q, icon: LOGO });
    });
    p.appendAction('Clear recent searches', function() {
      jset('recentSearches', []);
      p.redirect(PREFIX + ':search');
    });
  }
  p.appendItem('', 'separator', { title: 'Browse without typing' });
  util.each(orderedSections(true), function(s) {
    if(s.type === 'artist') return;
    p.appendItem(PREFIX + ':az:' + s.key, 'directory', { title: s.title + ' A-Z', icon: LOGO });
  });
  p.loading = false;
});

new page.Route(PREFIX + ':search:(.+)$', function(p, q) {
  if(!requireAuth(p)) return;
  q = decodeURIComponent(q);
  rememberSearch(q);
  setHeader(p, 'Search: ' + q);
  var n = renderSearch(p, q, 30);
  if(n === 0) p.appendPassiveItem('directory', '', { title: 'No results for "' + q + '"' });
  p.loading = false;
});

var TYPE_NUM = { movie: 1, show: 2, season: 3, episode: 4, artist: 8, album: 9, track: 10 };

new page.Route(PREFIX + ':searchall:([a-z]+):(.+)$', function(p, type, q) {
  if(!requireAuth(p)) return;
  q = decodeURIComponent(q);
  setHeader(p, (HUB_TITLES[type] || type) + ' matching "' + q + '"');
  var secs = orderedSections(true);
  var want = { movie: 'movie', show: 'show', episode: 'show', artist: 'artist', album: 'artist', track: 'artist' }[type];
  var targets = util.filter(secs, function(s) { return s.type === want; });
  if(!targets.length || !TYPE_NUM[type]) {
    renderSearch(p, q, 200);
    p.loading = false;
    return;
  }
  // Page through each enabled library of the right kind in turn.
  var ti = 0;
  paged(p, function(start, size) {
    while(ti < targets.length) {
      var r = api.sectionAll(targets[ti].key, { title: q, type: TYPE_NUM[type] }, start, size);
      if(r && r.items.length) return { items: r.items, total: start + r.items.length + (start + r.items.length < r.total ? 1 : 0) };
      ti++;
      start = 0;
    }
    return { items: [], total: start };
  }, {});
});

// Movian global search (Searcher hook): results appear in Movian's own
// search page under a "Plex" heading.
new page.Searcher('Plex', LOGO, function(p, query) {
  if(!isLinked()) return;
  var enabled = enabledSectionIds();
  var hubs = api.search(query, 20);
  if(!hubs) return;
  util.each(HUB_ORDER, function(t) {
    util.each(hubs, function(h) {
      if(h.type !== t || !h.size) return;
      appendItems(p, hubHasEnabled(h, enabled), {});
    });
  });
  p.entries = p.getItems().length;
});

// ---------------------------------------------------------------------------
// Audio / subtitle track selection (sets the Plex default streams for the
// part; used by transcodes and as the default for direct play)
// ---------------------------------------------------------------------------
function streamLabel(s) {
  var t = s.displayTitle || s.extendedDisplayTitle || s.title || s.language || s.codec || ('stream ' + s.id);
  if(s.streamType === 2 && s.codec) t += ' [' + String(s.codec).toUpperCase() + (s.channels ? ' ' + s.channels + 'ch' : '') + ']';
  if(s.streamType === 3 && s.key) t += ' (external)';
  if(s.streamType === 3 && !s.key && s.codec) t += ' [' + s.codec + ']';
  return (s.selected ? '* ' : '  ') + t;
}

new page.Route(PREFIX + ':streams:([0-9]+)$', function(p, rk) {
  if(!requireAuth(p)) return;
  var m = api.metadata(rk);
  if(!m) return fail(p, 'Item not found: ' + api.lastError);
  var plan = decide.decide(m, { mode: conf.playbackMode, quality: conf.quality });
  setHeader(p, 'Tracks: ' + titleFor(m, {}), thumbFor(m));
  if(!plan.partId) return fail(p, 'Item has no playable part');
  p.appendPassiveItem('directory', '', { title: 'Choose the audio and subtitle track Plex should use. The choice is stored on the server.' });
  p.appendAction('Play now', function() { p.redirect(PREFIX + ':play:' + rk); });
  p.appendItem('', 'separator', { title: 'Audio' });
  util.each(plan.audioStreams, function(s) {
    p.appendAction(streamLabel(s), function() {
      var r = api.selectStreams(plan.partId, s.id, undefined);
      notify(r.ok ? 'Audio: ' + (s.displayTitle || s.language || s.codec) : 'Server refused (' + r.error + ')', 3);
      p.redirect(PREFIX + ':streams:' + rk);
    });
  });
  p.appendItem('', 'separator', { title: 'Subtitles' });
  p.appendAction('  None', function() {
    var r = api.selectStreams(plan.partId, undefined, 0);
    notify(r.ok ? 'Subtitles off' : 'Server refused (' + r.error + ')', 3);
    p.redirect(PREFIX + ':streams:' + rk);
  });
  util.each(plan.subtitleStreams, function(s) {
    p.appendAction(streamLabel(s), function() {
      var r = api.selectStreams(plan.partId, undefined, s.id);
      notify(r.ok ? 'Subtitles: ' + (s.displayTitle || s.language) : 'Server refused (' + r.error + ')', 3);
      p.redirect(PREFIX + ':streams:' + rk);
    });
  });
  p.appendPassiveItem('directory', '', { title: 'During direct play use Movian\'s own menu (Triangle) to switch embedded tracks. Transcodes use the tracks chosen here; burned subtitles need Settings > Plex.' });
  p.loading = false;
});

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
var sessions = {};   // ratingKey -> {session, plan, durationMs, lastTime, timer, state}

function sessionId() {
  return util.uuid();
}

function buildVideoParams(m, plan, session) {
  var sources = [];
  var subtitles = [];
  var canonical = PREFIX + ':play:' + plan.ratingKey + '#' + session;

  if(plan.mode === 'direct') {
    sources.push({ url: api.partUrl(plan.partKey), mimetype: mimeFor(plan.container) });
  } else {
    var url = api.transcodeUrl(plan, session);
    // Movian's HLS backend handles "hls:" URLs (src/backend/hls/hls.c:2294)
    sources.push({ url: 'hls:' + url, mimetype: 'application/vnd.apple.mpegurl' });
  }

  if(!(plan.transcode && plan.transcode.burnSubtitles)) {
    util.each(plan.externalSubtitles, function(s) {
      subtitles.push({
        url: api.streamUrl(s.id, s.format === 'srt' || s.format === 'ass' || s.format === 'ssa' || s.format === 'vtt' ? null : 'srt'),
        title: s.title,
        language: s.languageCode || s.language,
        source: 'Plex'
      });
    });
  }

  var vp = {
    title: titleFor(m, {}),
    canonicalUrl: canonical,
    icon: thumbFor(m),
    sources: sources,
    subtitles: subtitles,
    no_fs_scan: true,
    no_subtitle_scan: true
  };
  if(m.year) vp.year = m.year;
  if(m.type === 'episode') {
    if(m.parentIndex !== undefined) vp.season = m.parentIndex;
    if(m.index !== undefined) vp.episode = m.index;
  }
  return 'videoparams:' + JSON.stringify(vp);
}

function mimeFor(container) {
  return {
    mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    avi: 'video/x-msvideo', mpegts: 'video/mp2t', ts: 'video/mp2t', mpeg: 'video/mpeg', mpg: 'video/mpeg'
  }[container] || 'video/' + container;
}

/**
 * plex:play:{ratingKey}[:begin|:resume|:q:{quality}]
 *
 * Opened as a page by the UI (navOpen), so a blocking resume question is
 * fine here. When Movian plays the next queued item itself it opens the route
 * in sync mode with a 10 s deadline (src/video/video_playback.c:230); then no
 * dialog is shown.
 */
new page.Route(PREFIX + ':play:([0-9]+)(:begin|:resume|:q:[a-z0-9_.]+)?$', function(p, rk, mod) {
  if(!isLinked()) {
    p.redirect(PREFIX + ':link');
    return;
  }
  p.loading = true;
  var m = api.metadata(rk);
  if(!m) return fail(p, 'Could not load item ' + rk + ': ' + (api.lastError || 'no answer'));

  var quality = conf.quality;
  var forced = null;
  if(mod === ':begin') forced = 'begin';
  else if(mod === ':resume') forced = 'resume';
  else if(mod && mod.indexOf(':q:') === 0) quality = mod.substring(3);

  var how = '';
  try { how = String(p.root.how); } catch(e) { how = ''; }
  if(how === 'resume') forced = 'resume';
  if(how === 'beginning') forced = 'begin';

  var offset = util.toInt(m.viewOffset, 0);
  var durationMs = util.toInt(m.duration, 0);
  var resume = false;
  if(offset > RESUME_MIN_MS && offset < durationMs - 10000) {
    if(forced === 'resume') resume = true;
    else if(forced === 'begin') resume = false;
    else if(p.sync) resume = true;           // auto-advance: never block
    else resume = npopup.message('Resume ' + titleFor(m, {}) + ' from ' + util.fmtClock(offset) + '?\n\nOK = resume, Cancel = start over', true, true);
  }

  var plan = decide.decide(m, {
    mode: conf.playbackMode,
    quality: quality,
    burnSubtitles: conf.burnSubtitles,
    offsetMs: resume ? offset : 0
  });
  if(plan.mode === 'none') return fail(p, 'Nothing to play: ' + plan.reason);

  var session = sessionId();
  sessions[String(rk)] = { session: session, plan: plan, durationMs: durationMs, startedAt: util.now(), lastTime: resume ? offset : 0 };
  dlog('play ' + rk + ' mode=' + plan.mode + ' (' + plan.reason + ')' + (resume ? ' resume@' + offset : ''));
  if(conf.debug) notify(plan.mode + ': ' + plan.reason, 3);

  p.metadata.title = titleFor(m, {});
  p.type = 'video';
  p.source = buildVideoParams(m, plan, session);
  p.loading = false;
});

// ---------------------------------------------------------------------------
// Timeline reporting (resume + watched state on the server)
// ---------------------------------------------------------------------------
var vs = new videoscrobbler.VideoScrobbler();

function sessionFor(data) {
  var cu = String((data && data.canonical_url) || '');
  var mm = new RegExp('^' + PREFIX + ':play:([0-9]+)#').exec(cu);
  if(!mm) return null;
  var s = sessions[mm[1]];
  if(!s) return null;
  s.ratingKey = mm[1];
  return s;
}

function report(s, state, timeMs) {
  if(timeMs === undefined || timeMs === null || isNaN(timeMs)) timeMs = s.lastTime || 0;
  s.lastTime = timeMs;
  api.timeline({ ratingKey: s.ratingKey, state: state, timeMs: timeMs, durationMs: s.durationMs, session: s.session });
}

function currentTimeMs(mpprop, s) {
  var t = NaN;
  try { t = parseFloat(mpprop.currenttime); } catch(e) { t = NaN; }
  if(isNaN(t)) return s.lastTime || 0;
  return Math.floor(t * 1000);
}

vs.onstart = function(data, mpprop, origin) {
  var s = sessionFor(data);
  if(!s) return;
  s.mp = mpprop;
  report(s, 'playing', currentTimeMs(mpprop, s));
  if(s.timer) clearInterval(s.timer);
  s.timer = setInterval(function() {
    var paused = false;
    try { paused = String(mpprop.playstatus) === 'pause'; } catch(e) {}
    report(s, paused ? 'paused' : 'playing', currentTimeMs(mpprop, s));
  }, TIMELINE_INTERVAL_MS);
};

vs.onpause = function(data, mpprop) {
  var s = sessionFor(data);
  if(s) report(s, 'paused', currentTimeMs(mpprop, s));
};

vs.onresume = function(data, mpprop) {
  var s = sessionFor(data);
  if(s) report(s, 'playing', currentTimeMs(mpprop, s));
};

vs.onstop = function(data, mpprop) {
  var s = sessionFor(data);
  if(!s) return;
  if(s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  var t = currentTimeMs(mpprop, s);
  if(data && data.stopposition !== undefined) t = Math.floor(data.stopposition * 1000);
  // Movian clears stopposition when the user watched to the end; Plex then
  // gets time == duration and marks the item watched itself.
  if(data && data.stopposition === undefined && data.duration) t = Math.floor(data.duration * 1000);
  report(s, 'stopped', t);
  if(s.plan && s.plan.mode !== 'direct') api.transcodeStop(s.session);
  delete sessions[s.ratingKey];
};

ilog('movian-plex ' + PLUGIN_VERSION + ' loaded (' + (isPS3 ? 'PlayStation 3' : 'desktop') + ', client ' + st.clientId + ')');
