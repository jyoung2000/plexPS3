'use strict';
exports.create = function(world) {
  return { create(title, url, type, enabled, icon) { const s = { title, url, type, enabled, icon, destroy() {} }; world.services.push(s); return s; } };
};
