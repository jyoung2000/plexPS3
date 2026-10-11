/*
 * Node stand-in for Movian's module loader (src/ecmascript/ecmascript.c
 * es_modsearch): 'movian/x' and 'native/x' resolve to the shims in this
 * directory, 'lib/x' resolves inside plugin/, everything else is Node.
 *
 * Usage:  const env = require('./loader').create({pluginDir, env});
 *         env.require('lib/decide')         // pure modules
 *         env.loadPlugin()                  // evaluates plugin/plugin.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SHIMS = {
  'movian/page': './movian-page',
  'movian/service': './movian-service',
  'movian/settings': './movian-settings',
  'movian/store': './movian-store',
  'movian/http': './movian-http',
  'movian/popup': './movian-popup',
  'movian/prop': './movian-prop',
  'movian/videoscrobbler': './movian-videoscrobbler',
  'native/popup': './native-popup',
  'native/string': './native-string'
};

exports.create = function(opts) {
  opts = opts || {};
  const pluginDir = opts.pluginDir || path.resolve(__dirname, '..', '..', 'plugin');
  const storageDir = opts.storageDir || fs.mkdtempSync(path.join(require('os').tmpdir(), 'movian-plex-'));
  const manifest = fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8');

  // State shared by the shims (recorded pages, popups, settings values...)
  const world = {
    pluginDir,
    storageDir,
    routes: [],
    searchers: [],
    services: [],
    settings: null,
    notifications: [],
    messages: [],        // popup.message() questions asked
    messageAnswer: true, // what popup.message() returns
    textAnswer: null,    // what popup.textDialog() returns (null = rejected)
    openedUrls: [],      // openurl events sent to the navigator
    timers: [],
    scrobblers: [],
    http: opts.http || null, // function(url, ctrl[, cb]) -> Movian-like response
    log: []
  };

  const cache = {};
  const context = vm.createContext({
    Plugin: {
      id: 'plex',
      url: 'file://' + pluginDir + '/',
      path: pluginDir + '/',
      manifest,
      apiversion: 2
    },
    Core: {
      currentVersionInt: 50000,
      currentVersionString: '5.0.0-node-shim',
      deviceId: 'node-shim-device',
      storagePath: opts.storagePath || storageDir
    },
    Duktape: { fin() {} },
    console: {
      log: (...a) => { world.log.push(a.join(' ')); if(opts.verbose) console.log(...a); },
      error: (...a) => { world.log.push('ERROR ' + a.join(' ')); if(opts.verbose) console.error(...a); },
      warn: (...a) => { world.log.push('WARN ' + a.join(' ')); }
    },
    print: (...a) => world.log.push(a.join(' ')),
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); world.timers.push(t); return t; },
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); world.timers.push(t); return t; },
    clearInterval,
    JSON, Math, Date, String, Number, Object, Array, Error, RegExp, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent
  });

  function load(id) {
    if(cache[id]) return cache[id].exports;
    let file;
    if(SHIMS[id]) {
      const m = require(SHIMS[id]);
      const ex = typeof m.create === 'function' ? m.create(world, env) : m;
      cache[id] = { exports: ex };
      return ex;
    }
    if(id.startsWith('native/') || id.startsWith('movian/'))
      throw new Error("Can't find module " + id + ' (no shim)');
    file = path.join(pluginDir, id + '.js');
    if(!fs.existsSync(file)) throw new Error("Can't find module " + id + ' at ' + file);
    const module = { exports: {} };
    cache[id] = module;
    const src = fs.readFileSync(file, 'utf8');
    const fn = vm.runInContext('(function(require, exports, module, __filename){' + src + '\n})', context, { filename: file });
    fn(load, module.exports, module, file);
    return module.exports;
  }

  const env = {
    world,
    context,
    require: load,
    loadPlugin() {
      const file = path.join(pluginDir, 'plugin.js');
      const src = fs.readFileSync(file, 'utf8');
      const fn = vm.runInContext('(function(require, exports, module, __filename){' + src + '\n})', context, { filename: file });
      const module = { exports: {} };
      fn(load, module.exports, module, file);
      return world;
    },
    // Run a registered route as Movian would: returns the recorded page.
    open(url, extra) {
      for(const r of world.routes) {
        const m = r.re.exec(url);
        if(m) {
          const page = require('./movian-page').newPage(world, url, extra);
          try {
            r.callback.apply(null, [page.api].concat(m.slice(1)));
          } catch(e) {
            page.exception = e;
          }
          return page;
        }
      }
      throw new Error('No route for ' + url);
    },
    cleanup() {
      world.timers.forEach(t => clearTimeout(t));
      world.timers.forEach(t => clearInterval(t));
    }
  };
  return env;
};
