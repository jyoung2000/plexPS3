'use strict';
// Mirrors modules/movian/settings.js globalSettings(): values persisted in
// a JSON file, callbacks invoked with the initial value at creation time.
const fs = require('fs');
const path = require('path');
exports.create = function(world) {
  function globalSettings(id, title, icon, desc) {
    const file = path.join(world.storageDir, 'settings', id);
    let keys = {};
    try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
    const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(keys)); };
    const g = { id, title, icon, desc, items: {}, actions: {}, properties: { url: 'settings:apps/' + id } };
    function mk(sid, type, def, cb) {
      let value = sid in keys ? keys[sid] : def;
      const item = {
        type,
        get value() { return value; },
        set value(v) { value = v; keys[sid] = v; save(); cb(v); },
        enabled: true
      };
      g.items[sid] = item;
      cb(value);
      return item;
    }
    g.createString = (sid, t, def, cb) => mk(sid, 'string', def, cb);
    g.createBool = (sid, t, def, cb) => mk(sid, 'bool', def, cb);
    g.createInt = (sid, t, def, min, max, step, unit, cb) => mk(sid, 'int', def, cb);
    g.createMultiOpt = (sid, t, options, cb) => {
      let init = sid in keys ? keys[sid] : null;
      if(init === null) options.forEach(o => { if(o[2]) init = String(o[0]); });
      if(!init) init = String(options[0][0]);
      const item = mk(sid, 'multiopt', init, cb);
      item.options = options;
      return item;
    };
    g.createAction = (sid, t, cb) => { g.actions[sid] = { title: t, cb }; return { title: t }; };
    g.createDivider = () => {};
    g.createInfo = () => {};
    g.destroy = () => {};
    world.settings = g;
    return g;
  }
  return { globalSettings, kvstoreSettings: globalSettings };
};
