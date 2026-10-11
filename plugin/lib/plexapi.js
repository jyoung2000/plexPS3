/*
 * movian-plex: all HTTP traffic and URL building for Plex Media Server and
 * plex.tv. No Movian UI calls in this file. The HTTP function is injected so
 * the same code runs under Node (test/shim) and inside Movian.
 *
 * Injected http(url, ctrl[, callback]) must behave like Movian's
 * require('movian/http').request (res/ecmascript/modules/movian/http.js):
 *   ctrl = {method, headers, postdata, noFail}
 *   returns {statuscode, headers_lc, toString()} or throws on socket errors.
 *   With a callback: callback(err, response) and returns undefined.
 */
'use strict';

var util = require('lib/util');

var PLEX_TV = 'https://plex.tv';
var LIBRARY_IDENTIFIER = 'com.plexapp.plugins.library';

// Verified against PMS 1.43 (see docs/movian-api.md "Plex transcode profile"):
// forces an HLS/MPEG-TS target with H.264 (<= level 4.1, 8-bit) + stereo AAC.
var PROFILE_EXTRA = [
  'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac&subtitleCodec=&replace=true)',
  'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.level&value=41&replace=true)',
  'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.bitDepth&value=8&replace=true)',
  'add-limitation(scope=videoAudioCodec&scopeName=aac&type=upperBound&name=audio.channels&value=2&replace=true)'
].join('+');
exports.PROFILE_EXTRA = PROFILE_EXTRA;

/**
 * cfg = {
 *   http:       injected request function (see above)
 *   identity:   {clientId, product, version, platform, platformVersion, device, deviceName}
 *   getServer:  function() -> 'http://ip:32400' or ''
 *   getToken:   function() -> token or ''
 *   log:        function(line)            (optional)
 *   isDebug:    function() -> boolean     (optional)
 *   onStatus:   function(status, url)     (optional, e.g. 401 handling)
 * }
 */
exports.create = function(cfg) {
  var api = {};
  var http = cfg.http;
  var identity = cfg.identity || {};

  function debug() {
    return cfg.isDebug ? !!cfg.isDebug() : false;
  }
  function log(line) {
    if(cfg.log) cfg.log(line);
  }

  api.identity = identity;
  api.lastError = null;

  api.server = function() {
    var s = cfg.getServer ? cfg.getServer() : '';
    return s ? util.normalizeServerUrl(s) : '';
  };
  api.token = function() {
    return cfg.getToken ? (cfg.getToken() || '') : '';
  };

  api.identityParams = function() {
    var p = {
      'X-Plex-Client-Identifier': identity.clientId,
      'X-Plex-Product': identity.product,
      'X-Plex-Version': identity.version,
      'X-Plex-Platform': identity.platform,
      'X-Plex-Platform-Version': identity.platformVersion,
      'X-Plex-Device': identity.device,
      'X-Plex-Device-Name': identity.deviceName,
      'X-Plex-Model': identity.model,
      'X-Plex-Provides': 'player'
    };
    return p;
  };

  api.headers = function(extra, token) {
    var h = api.identityParams();
    h.Accept = 'application/json';
    var t = token === undefined ? api.token() : token;
    if(t) h['X-Plex-Token'] = t;
    return util.extend(h, extra);
  };

  // ------------------------------------------------------------------
  // URL builders
  // ------------------------------------------------------------------

  // Server URL with token in the query (needed for images/media the player
  // fetches itself, where we cannot set headers).
  api.url = function(path, params, noToken) {
    var base = api.server();
    var p = util.extend({}, params);
    if(!noToken && api.token()) p['X-Plex-Token'] = api.token();
    return util.withQuery(util.joinUrl(base, path), p);
  };

  api.thumb = function(path, width, height) {
    if(!path) return null;
    return api.url('/photo/:/transcode', {
      width: width || 300,
      height: height || 450,
      minSize: 1,
      upscale: 1,
      url: path
    });
  };

  api.partUrl = function(key) {
    return api.url(key, {});
  };

  api.streamUrl = function(streamId, format) {
    // Movian loads srt/ass/vtt itself. Ask Plex for the original format.
    var path = '/library/streams/' + streamId;
    return api.url(path, format ? { encoding: 'utf-8', format: format } : { encoding: 'utf-8' });
  };

  /**
   * HLS session URL for a decide.js plan with transcode != null.
   */
  api.transcodeUrl = function(plan, session, extra) {
    var t = plan.transcode || {};
    var params = util.extend({
      path: '/library/metadata/' + plan.ratingKey,
      mediaIndex: plan.mediaIndex || 0,
      partIndex: plan.partIndex || 0,
      protocol: 'hls',
      directPlay: 0,
      directStream: t.directStream ? 1 : 0,
      directStreamAudio: t.directStream ? 1 : 0,
      fastSeek: 1,
      offset: t.offsetSec || 0,
      videoQuality: 100,
      subtitles: t.burnSubtitles ? 'burn' : 'none',
      copyts: 0,
      session: session,
      'X-Plex-Session-Identifier': session,
      'X-Plex-Client-Profile-Extra': PROFILE_EXTRA
    }, api.identityParams(), extra);
    if(t.maxVideoBitrate) params.maxVideoBitrate = t.maxVideoBitrate;
    if(t.videoResolution) params.videoResolution = t.videoResolution;
    return api.url('/video/:/transcode/universal/start.m3u8', params);
  };

  // ------------------------------------------------------------------
  // Transport
  // ------------------------------------------------------------------

  function finish(method, url, t0, res, err) {
    var out = { ok: false, status: 0, text: '', json: null, error: null, ms: util.now() - t0, headers: {} };
    if(err || !res) {
      out.error = String(err || 'no response');
      api.lastError = out.error;
      log('HTTP ' + method + ' ' + util.redact(url) + ' -> ERROR ' + out.error + ' (' + out.ms + ' ms)');
      return out;
    }
    out.status = res.statuscode || 0;
    out.headers = res.headers_lc || {};
    out.ok = out.status >= 200 && out.status < 300;
    try {
      out.text = res.toString();
    } catch(e) {
      out.text = '';
    }
    var first = util.trim(out.text).charAt(0);
    if(first === '{' || first === '[') out.json = util.parseJSON(out.text);
    if(!out.ok) {
      out.error = 'HTTP ' + out.status;
      api.lastError = out.error;
    }
    if(debug() || !out.ok)
      log('HTTP ' + method + ' ' + util.redact(url) + ' -> ' + out.status + ' (' + out.ms + ' ms)');
    if(cfg.onStatus) cfg.onStatus(out.status, url);
    return out;
  }

  /**
   * Synchronous request. Never throws: socket errors become {ok:false,status:0}.
   */
  api.request = function(method, url, opts) {
    opts = opts || {};
    var t0 = util.now();
    var ctrl = {
      method: method,
      headers: opts.headers || api.headers(),
      noFail: true
    };
    if(opts.postdata !== undefined) ctrl.postdata = opts.postdata;
    try {
      var res = http(url, ctrl);
      return finish(method, url, t0, res, null);
    } catch(e) {
      return finish(method, url, t0, null, e);
    }
  };

  /** Asynchronous request: cb(result) with the same shape as api.request. */
  api.requestAsync = function(method, url, opts, cb) {
    opts = opts || {};
    var t0 = util.now();
    var ctrl = {
      method: method,
      headers: opts.headers || api.headers(),
      noFail: true
    };
    if(opts.postdata !== undefined) ctrl.postdata = opts.postdata;
    try {
      http(url, ctrl, function(err, res) {
        cb(finish(method, url, t0, res, err));
      });
    } catch(e) {
      cb(finish(method, url, t0, null, e));
    }
  };

  api.get = function(path, params, opts) {
    return api.request('GET', api.url(path, params, true), opts);
  };
  api.put = function(path, params, opts) {
    return api.request('PUT', api.url(path, params, true), opts);
  };

  // Returns the MediaContainer object or null (api.lastError set).
  api.container = function(path, params) {
    var r = api.get(path, params);
    if(!r.ok || !r.json || !r.json.MediaContainer) {
      if(r.ok && !r.json) api.lastError = 'server did not return JSON for ' + path;
      return null;
    }
    return r.json.MediaContainer;
  };

  // ------------------------------------------------------------------
  // Plex Media Server endpoints (all verified live, see test/fixtures)
  // ------------------------------------------------------------------

  api.identityInfo = function(serverUrl) {
    var url = util.joinUrl(serverUrl || api.server(), '/identity');
    var r = api.request('GET', url, { headers: api.headers({}, '') });
    if(r.ok && r.json && r.json.MediaContainer) return r.json.MediaContainer;
    return null;
  };

  api.sections = function() {
    var c = api.container('/library/sections');
    return c ? (c.Directory || []) : null;
  };

  /**
   * Generic paged listing. Returns {items, total, start, size} or null.
   */
  api.page = function(path, params, start, size) {
    var p = util.extend({
      'X-Plex-Container-Start': start || 0,
      'X-Plex-Container-Size': size || 50
    }, params);
    var c = api.container(path, p);
    if(!c) return null;
    var items = c.Metadata || c.Directory || c.Hub || [];
    var total = c.totalSize !== undefined ? util.toInt(c.totalSize, items.length) : util.toInt(c.size, items.length);
    return { items: items, total: total, start: start || 0, size: items.length, container: c };
  };

  api.sectionAll = function(sectionId, params, start, size) {
    return api.page('/library/sections/' + sectionId + '/all', params, start, size);
  };

  api.metadata = function(ratingKey) {
    var c = api.container('/library/metadata/' + ratingKey, { includeExternalMedia: 0, checkFiles: 0 });
    return c && c.Metadata && c.Metadata.length ? c.Metadata[0] : null;
  };

  api.children = function(ratingKey, start, size, params) {
    return api.page('/library/metadata/' + ratingKey + '/children', params, start, size);
  };

  api.onDeck = function(size) {
    return api.page('/library/onDeck', {}, 0, size || 20);
  };

  api.continueWatching = function() {
    var c = api.container('/hubs/continueWatching');
    if(!c || !c.Hub || !c.Hub.length) return [];
    return c.Hub[0].Metadata || [];
  };

  api.recentlyAdded = function(size, start) {
    return api.page('/library/recentlyAdded', {}, start || 0, size || 20);
  };

  api.sectionRecentlyAdded = function(sectionId, size) {
    return api.page('/library/sections/' + sectionId + '/recentlyAdded', {}, 0, size || 20);
  };

  /** Global search. Returns array of hubs: {type, title, size, more, Metadata[]} */
  api.search = function(query, limit, sectionId) {
    var p = { query: query, limit: limit || 30, includeCollections: 1 };
    if(sectionId) p.sectionId = sectionId;
    var c = api.container('/hubs/search', p);
    return c ? (c.Hub || []) : null;
  };

  api.firstCharacters = function(sectionId, type) {
    var p = type ? { type: type } : {};
    var c = api.container('/library/sections/' + sectionId + '/firstCharacter', p);
    return c ? (c.Directory || []) : null;
  };

  api.firstCharacterItems = function(sectionId, ch, params, start, size) {
    return api.page('/library/sections/' + sectionId + '/firstCharacter/' + encodeURIComponent(ch), params, start, size);
  };

  // name: genre | year | decade | contentRating | resolution | collection | actor | director
  api.filterValues = function(sectionId, name, type) {
    var p = type ? { type: type } : {};
    var c = api.container('/library/sections/' + sectionId + '/' + name, p);
    return c ? (c.Directory || []) : null;
  };

  api.selectStreams = function(partId, audioStreamId, subtitleStreamId) {
    var p = { allParts: 1 };
    if(audioStreamId !== undefined && audioStreamId !== null) p.audioStreamID = audioStreamId;
    if(subtitleStreamId !== undefined && subtitleStreamId !== null) p.subtitleStreamID = subtitleStreamId;
    return api.put('/library/parts/' + partId, p);
  };

  api.timeline = function(o) {
    return api.get('/:/timeline', {
      ratingKey: o.ratingKey,
      key: '/library/metadata/' + o.ratingKey,
      identifier: LIBRARY_IDENTIFIER,
      state: o.state,
      time: Math.max(0, Math.floor(o.timeMs || 0)),
      duration: Math.max(0, Math.floor(o.durationMs || 0)),
      hasMDE: 1,
      playbackTime: Math.max(0, Math.floor(o.timeMs || 0)),
      'X-Plex-Session-Identifier': o.session
    }, { headers: api.headers({ 'X-Plex-Session-Identifier': o.session || '' }) });
  };

  api.scrobble = function(ratingKey) {
    return api.get('/:/scrobble', { key: ratingKey, identifier: LIBRARY_IDENTIFIER });
  };
  api.unscrobble = function(ratingKey) {
    return api.get('/:/unscrobble', { key: ratingKey, identifier: LIBRARY_IDENTIFIER });
  };

  api.transcodeStop = function(session) {
    return api.get('/video/:/transcode/universal/stop', { session: session });
  };

  // Verifies the server accepts our token. Returns {ok, status, machineIdentifier, name}
  api.validate = function() {
    var id = api.identityInfo();
    if(!id) return { ok: false, status: 0, error: api.lastError || 'server unreachable' };
    var r = api.get('/library/sections');
    if(!r.ok) return { ok: false, status: r.status, error: r.error, machineIdentifier: id.machineIdentifier };
    var c = r.json && r.json.MediaContainer;
    return {
      ok: true,
      status: 200,
      machineIdentifier: id.machineIdentifier,
      name: c && c.title1,
      sections: c ? (c.Directory || []) : [],
      version: id.version
    };
  };

  // ------------------------------------------------------------------
  // plex.tv (HTTPS). Every call fails soft.
  // ------------------------------------------------------------------

  function plexTv(method, path, params, token, opts) {
    var url = util.withQuery(PLEX_TV + path, params);
    var headers = api.headers({}, token || '');
    var o = util.extend({ headers: headers }, opts);
    return api.request(method, url, o);
  }

  // POST /api/v2/pins?strong=false -> {id, code, expiresIn}
  api.pinCreate = function() {
    var r = plexTv('POST', '/api/v2/pins', { strong: 'false' }, '', { postdata: '' });
    if(!r.ok || !r.json || !r.json.code) return { ok: false, error: r.error || 'no code', status: r.status };
    return { ok: true, id: r.json.id, code: r.json.code, expiresIn: util.toInt(r.json.expiresIn, 900), status: r.status };
  };

  // GET /api/v2/pins/{id} -> authToken when the user has entered the code
  api.pinCheck = function(id) {
    var r = plexTv('GET', '/api/v2/pins/' + id, {}, '');
    if(!r.ok || !r.json) return { ok: false, error: r.error, status: r.status };
    return { ok: true, authToken: r.json.authToken || null, expiresIn: util.toInt(r.json.expiresIn, 0), status: r.status };
  };

  api.user = function(token) {
    var r = plexTv('GET', '/api/v2/user', {}, token);
    return r.ok ? r.json : null;
  };

  /**
   * GET /api/v2/resources?includeHttps=1&includeRelay=0
   * -> servers [{name, clientIdentifier, accessToken, owned, connections:[{uri, address, port, protocol, local, relay}]}]
   */
  api.resources = function(token) {
    var r = plexTv('GET', '/api/v2/resources', { includeHttps: 1, includeRelay: 0, includeIPv6: 0 }, token);
    if(!r.ok || !r.json || !util.isArray(r.json)) return null;
    return util.filter(r.json, function(res) {
      return /server/.test(String(res.provides || '')) && !!res.connections;
    });
  };

  /**
   * Candidate plain-http LAN URLs for a resource, best first.
   */
  api.localHttpConnections = function(resource) {
    var conns = util.filter(resource.connections || [], function(c) {
      return !c.relay && String(c.protocol).toLowerCase() === 'http' && c.address && c.port;
    });
    // local=true first, then private IPv4, then the rest
    conns.sort(function(a, b) {
      var sa = (a.local ? 2 : 0) + (util.isPrivateIPv4(a.address) ? 1 : 0);
      var sb = (b.local ? 2 : 0) + (util.isPrivateIPv4(b.address) ? 1 : 0);
      return sb - sa;
    });
    var seen = {}, out = [];
    util.each(conns, function(c) {
      var u = 'http://' + c.address + ':' + c.port;
      if(seen[u]) return;
      seen[u] = 1;
      out.push(u);
    });
    // Secure connections = Required servers only list https; derive http
    // anyway, the PS3 cannot do their TLS. The probe decides.
    if(!out.length) {
      util.each(resource.connections || [], function(c) {
        if(c.relay || !c.address || !c.port) return;
        var u = 'http://' + c.address + ':' + c.port;
        if(seen[u]) return;
        seen[u] = 1;
        out.push(u);
      });
    }
    return out;
  };

  /**
   * Probe a list of base URLs with GET /identity in parallel; cb(url, identity)
   * with the first that answers, or cb(null) after timeoutMs.
   */
  api.probe = function(urls, timeoutMs, cb) {
    var done = false, pending = urls.length;
    if(!pending) return cb(null, null);
    var timer = setTimeout(function() {
      if(done) return;
      done = true;
      cb(null, null);
    }, timeoutMs || 5000);
    util.each(urls, function(u) {
      api.requestAsync('GET', util.joinUrl(u, '/identity'), { headers: api.headers({}, '') }, function(r) {
        pending--;
        if(done) return;
        if(r.ok && r.json && r.json.MediaContainer) {
          done = true;
          clearTimeout(timer);
          cb(u, r.json.MediaContainer);
        } else if(pending === 0) {
          done = true;
          clearTimeout(timer);
          cb(null, null);
        }
      });
    });
  };

  return api;
};
