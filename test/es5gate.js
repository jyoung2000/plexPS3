#!/usr/bin/env node
/*
 * ES5 gate:
 *  1. parse every plugin/**\/*.js with espree at ecmaVersion 5 (Duktape 1.x
 *     is an ES5 engine; anything newer fails here before it fails on the PS3),
 *  2. load every lib module and plugin.js through the Movian shims with an
 *     HTTP stub that always fails, to catch top-level runtime errors.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pluginDir = path.join(root, 'plugin');

function walk(dir) {
  return fs.readdirSync(dir).flatMap(f => {
    const p = path.join(dir, f);
    return fs.statSync(p).isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });
}

let espree;
try {
  espree = require('espree');
} catch(e) {
  const eslintDir = path.dirname(require.resolve('eslint/package.json', { paths: [root, '/opt/node22/lib/node_modules'] }));
  espree = require(require.resolve('espree', { paths: [eslintDir] }));
}

let failed = 0;
const files = walk(pluginDir);
for(const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    espree.parse(src, { ecmaVersion: 5, sourceType: 'script' });
    console.log('ES5 parse ok   ' + path.relative(root, f));
  } catch(e) {
    failed++;
    console.log('ES5 parse FAIL ' + path.relative(root, f) + ': ' + e.message);
  }
}

const loader = require('./shim/loader');
const env = loader.create({
  http: function(url, ctrl, cb) {
    const res = { statuscode: 503, headers_lc: {}, toString: () => 'stub' };
    if(cb) { setTimeout(() => cb(null, res), 0); return; }
    return res;
  }
});
for(const mod of ['lib/util', 'lib/decide', 'lib/plexapi']) {
  try {
    env.require(mod);
    console.log('load ok        plugin/' + mod + '.js');
  } catch(e) {
    failed++;
    console.log('load FAIL      plugin/' + mod + '.js: ' + (e.stack || e));
  }
}
try {
  const world = env.loadPlugin();
  console.log('load ok        plugin/plugin.js (' + world.routes.length + ' routes, ' + world.searchers.length + ' searcher, ' + world.scrobblers.length + ' scrobbler)');
  // Every route must survive a dead server without throwing.
  for(const r of world.routes) {
    const sample = r.re.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\[0-9\]\+\)/g, '1').replace(/\(\.\+\)/g, 'x').replace(/\(\[a-z\]\+\)/g, 'movie').replace(/\(\[a-zA-Z\]\+\)/g, 'genre').replace(/\((:begin\|:resume\|:q:\[a-z0-9_\.\]\+)\)\?/g, '');
    const page = env.open(sample);
    if(page.exception) {
      failed++;
      console.log('route FAIL     ' + sample + ': ' + (page.exception.stack || page.exception));
    }
  }
  console.log('routes ok      all routes fail soft with an unreachable server');
  env.cleanup();
} catch(e) {
  failed++;
  console.log('load FAIL      plugin/plugin.js: ' + (e.stack || e));
}

if(failed) {
  console.log('\nES5 gate: ' + failed + ' problem(s)');
  process.exit(1);
}
console.log('\nES5 gate: OK (' + files.length + ' files)');
