'use strict';
const { workerData, parentPort } = require('worker_threads');
const http = require('http');
const https = require('https');

const { url, ctrl, sab, out } = workerData;
const flag = new Int32Array(sab);

function finish(obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  Buffer.from(out).set(buf.subarray(0, out.byteLength), 0);
  Atomics.store(flag, 0, buf.length);
  Atomics.notify(flag, 0);
  parentPort.postMessage(buf.length);
}

try {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const headers = Object.assign({}, ctrl.headers || {});
  const method = ctrl.method || (ctrl.postdata !== undefined ? 'POST' : 'GET');
  let body = ctrl.postdata;
  if(body !== undefined && typeof body !== 'string') {
    body = Object.entries(body).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    if(!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if(body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
  const opts = { method, headers, timeout: ctrl.timeoutMs || 30000 };
  // Honour HTTPS_PROXY for plex.tv like the rest of the sandbox tooling.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if(u.protocol === 'https:' && proxy) {
    const p = new URL(proxy);
    http.request({ host: p.hostname, port: p.port, method: 'CONNECT', path: u.hostname + ':' + (u.port || 443) })
      .on('connect', (res, socket) => {
        if(res.statusCode !== 200) return finish({ error: 'proxy CONNECT ' + res.statusCode });
        const req = https.request(Object.assign({ host: u.hostname, path: u.pathname + u.search, socket, servername: u.hostname, ca: process.env.NODE_EXTRA_CA_CERTS ? require('fs').readFileSync(process.env.NODE_EXTRA_CA_CERTS) : undefined }, opts), onRes);
        req.on('error', e => finish({ error: String(e) }));
        if(body !== undefined) req.write(body);
        req.end();
      })
      .on('error', e => finish({ error: String(e) }))
      .end();
  } else {
    const req = mod.request(u, opts, onRes);
    req.on('error', e => finish({ error: String(e) }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if(body !== undefined) req.write(body);
    req.end();
  }
  function onRes(res) {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      if(!ctrl.noFail && res.statusCode >= 400) return finish({ error: 'HTTP error ' + res.statusCode });
      finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('base64') });
    });
  }
} catch(e) {
  finish({ error: String(e) });
}
