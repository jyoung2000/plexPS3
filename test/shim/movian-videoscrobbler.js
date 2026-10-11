'use strict';
exports.create = function(world) {
  function VideoScrobbler() { world.scrobblers.push(this); }
  VideoScrobbler.prototype.destroy = function() {};
  return { VideoScrobbler };
};
