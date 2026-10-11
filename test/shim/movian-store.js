'use strict';
// JSON file store with the same semantics as modules/movian/store.js but
// written synchronously (tests read it back immediately).
const fs = require('fs');
const path = require('path');
const shared = {};  // file -> keys, so tests and plugin see one store per file
exports.create = function(world) {
  function createFromPath(file) {
    if(!shared[file]) {
      shared[file] = {};
      try { shared[file] = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
    }
    const keys = shared[file];
    return new Proxy({}, {
      get: (o, k) => keys[k],
      set: (o, k, v) => { keys[k] = v; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(keys)); return true; },
      has: (o, k) => k in keys
    });
  }
  return {
    createFromPath,
    create(name) { return createFromPath(path.join(world.storageDir, 'store', name)); }
  };
};
