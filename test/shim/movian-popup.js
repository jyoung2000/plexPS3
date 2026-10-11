'use strict';
exports.create = function(world) {
  return { notify(text, delay, icon) { world.notifications.push(String(text)); } };
};
