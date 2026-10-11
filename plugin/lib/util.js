/*
 * movian-plex: small ES5 helpers shared by all modules.
 * No Movian APIs are used here so the file also runs under Node (tests).
 */
'use strict';

function isArray(x) {
  return Object.prototype.toString.call(x) === '[object Array]';
}
exports.isArray = isArray;

exports.each = function(arr, fn) {
  if(!arr) return;
  for(var i = 0; i < arr.length; i++) fn(arr[i], i);
};

exports.map = function(arr, fn) {
  var out = [];
  if(!arr) return out;
  for(var i = 0; i < arr.length; i++) out.push(fn(arr[i], i));
  return out;
};

exports.filter = function(arr, fn) {
  var out = [];
  if(!arr) return out;
  for(var i = 0; i < arr.length; i++) if(fn(arr[i], i)) out.push(arr[i]);
  return out;
};

exports.contains = function(arr, v) {
  if(!arr) return false;
  for(var i = 0; i < arr.length; i++) if(arr[i] === v) return true;
  return false;
};

exports.extend = function(dst) {
  for(var a = 1; a < arguments.length; a++) {
    var src = arguments[a];
    if(!src) continue;
    for(var k in src) if(Object.prototype.hasOwnProperty.call(src, k)) dst[k] = src[k];
  }
  return dst;
};

exports.trim = function(s) {
  return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, '');
};

exports.startsWith = function(s, prefix) {
  return String(s).slice(0, prefix.length) === prefix;
};

exports.pad2 = function(n) {
  n = Math.floor(n);
  return (n < 10 ? '0' : '') + n;
};

// 5425000 -> "1:30:25", 125000 -> "02:05"
exports.fmtClock = function(ms) {
  var s = Math.max(0, Math.floor((ms || 0) / 1000));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  if(h > 0) return h + ':' + exports.pad2(m) + ':' + exports.pad2(sec);
  return exports.pad2(m) + ':' + exports.pad2(sec);
};

// 5425000 -> "1h 30m", 125000 -> "2 min"
exports.fmtDuration = function(ms) {
  var mins = Math.round((ms || 0) / 60000);
  if(mins < 60) return mins + ' min';
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return h + 'h' + (m ? ' ' + exports.pad2(m) + 'm' : '');
};

// RFC4122-shaped random id. Duktape has no crypto.getRandomValues; Math.random
// is good enough for a client identifier that only needs to be unique.
exports.uuid = function() {
  var hex = '0123456789abcdef';
  var out = '';
  for(var i = 0; i < 36; i++) {
    if(i === 8 || i === 13 || i === 18 || i === 23) { out += '-'; continue; }
    if(i === 14) { out += '4'; continue; }
    var r = Math.floor(Math.random() * 16);
    if(i === 19) r = (r & 3) | 8;
    out += hex.charAt(r);
  }
  return out;
};

// {a: 1, b: 'x y'} -> "a=1&b=x%20y"  (null/undefined values are skipped)
exports.query = function(obj) {
  var parts = [];
  if(!obj) return '';
  for(var k in obj) {
    if(!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var v = obj[k];
    if(v === undefined || v === null) continue;
    if(isArray(v)) {
      for(var i = 0; i < v.length; i++)
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v[i])));
    } else {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
  }
  return parts.join('&');
};

// Append a query string to an URL that may or may not already have one.
exports.withQuery = function(url, obj) {
  var q = typeof obj === 'string' ? obj : exports.query(obj);
  if(!q) return url;
  return url + (url.indexOf('?') === -1 ? '?' : '&') + q;
};

// joinUrl('http://h:32400/', '/library/x') -> 'http://h:32400/library/x'
exports.joinUrl = function(base, path) {
  base = String(base || '');
  path = String(path || '');
  while(base.length && base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
  if(path.length && path.charAt(0) !== '/') path = '/' + path;
  return base + path;
};

// Normalise user input such as "192.168.1.10" or "192.168.1.10:32400/"
exports.normalizeServerUrl = function(s) {
  s = exports.trim(s);
  if(!s) return '';
  if(!/^https?:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/\/+$/, '');
  if(!/:\d+$/.test(s.replace(/^https?:\/\//i, ''))) s += ':32400';
  return s;
};

exports.redact = function(url) {
  return String(url).replace(/(X-Plex-Token=)[^&#]*/gi, '$1***').replace(/(authToken":")[^"]*/g, '$1***');
};

exports.parseJSON = function(text) {
  try {
    return JSON.parse(text);
  } catch(e) {
    return null;
  }
};

exports.now = function() {
  return new Date().getTime();
};

exports.clamp = function(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
};

exports.toInt = function(v, def) {
  var n = parseInt(v, 10);
  return isNaN(n) ? def : n;
};

// Only private LAN address families; plex.tv may also list public IPs.
exports.isPrivateIPv4 = function(addr) {
  var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(addr || ''));
  if(!m) return false;
  var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
};
