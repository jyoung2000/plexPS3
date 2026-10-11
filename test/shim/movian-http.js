'use strict';
/*
 * Real HTTP(S) requests via Node, returning the same response shape as
 * Movian's HttpResponse (res/ecmascript/modules/movian/http.js):
 *   {statuscode, headers, headers_lc, multiheaders_lc, contenttype, bytes, toString()}
 * Synchronous form (no callback) is implemented with a worker thread + Atomics
 * so plugin code written for Movian's blocking http.request runs unchanged.
 */
const { Worker } = require('worker_threads');
const path = require('path');

function makeResponse(r) {
  const headers = {}, headers_lc = {}, multi_lc = {};
  for(const [k, v] of Object.entries(r.headers || {})) {
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
    headers_lc[k.toLowerCase()] = headers[k];
    multi_lc[k.toLowerCase()] = Array.isArray(v) ? v : [v];
  }
  const bytes = Buffer.from(r.body || '', 'base64');
  return {
    statuscode: r.status,
    headers, headers_lc, multiheaders_lc: multi_lc,
    contenttype: headers_lc['content-type'],
    bytes,
    toString() { return bytes.toString('utf8'); },
    convertFromEncoding() { return bytes.toString('utf8'); }
  };
}

function requestSync(url, ctrl) {
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const out = new SharedArrayBuffer(16 * 1024 * 1024);
  const w = new Worker(path.join(__dirname, 'http-worker.js'), { workerData: { url, ctrl: ctrl || {}, sab, out } });
  w.on('error', () => {});
  Atomics.wait(flag, 0, 0, (ctrl && ctrl.timeoutMs) || 60000);
  const len = Atomics.load(flag, 0);
  w.terminate();
  if(len <= 0) throw new Error('HTTP request failed or timed out: ' + url.replace(/X-Plex-Token=[^&]*/g, 'X-Plex-Token=***'));
  const r = JSON.parse(Buffer.from(out, 0, len).toString('utf8'));
  if(r.error) throw new Error(r.error);
  return makeResponse(r);
}

function requestAsync(url, ctrl, cb) {
  const sab = new SharedArrayBuffer(4);
  const out = new SharedArrayBuffer(16 * 1024 * 1024);
  const w = new Worker(path.join(__dirname, 'http-worker.js'), { workerData: { url, ctrl: ctrl || {}, sab, out } });
  w.on('message', (len) => {
    const r = JSON.parse(Buffer.from(out, 0, len).toString('utf8'));
    w.terminate();
    if(r.error) cb(new Error(r.error), null);
    else cb(null, makeResponse(r));
  });
  w.on('error', (e) => cb(e, null));
}

exports.request = function(url, ctrl, cb) {
  if(cb) return requestAsync(url, ctrl, cb);
  return requestSync(url, ctrl);
};
exports.create = function(world) {
  if(world.http) return { request: world.http };
  return { request: exports.request };
};
