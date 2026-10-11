'use strict';
// Minimal prop tree: plain objects with a "zombie" flag. Enough for the
// plugin's uses: prop.global.navigators.current.eventSink, sendEvent,
// isZombie, subscribeValue, createRoot.
exports.create = function(world) {
  const api = {};
  api.global = { navigators: { current: { eventSink: { _navsink: true } }, nodes: [{ eventSink: { _navsink: true } }] } };
  api.createRoot = () => ({ metadata: {}, options: [] });
  api.makeProp = p => p;
  api.isZombie = p => !!(p && p.zombie);
  api.isValue = () => false;
  api.sendEvent = (p, type, args) => {
    world.events = world.events || [];
    world.events.push({ prop: p, type, args });
    if(type === 'openurl') world.openedUrls.push(args.url);
    if(type === 'redirect') world.openedUrls.push(args);
  };
  api.subscribeValue = (p, cb) => { world.subscriptions = world.subscriptions || []; world.subscriptions.push({ p, cb }); return {}; };
  api.subscribe = api.subscribeValue;
  api.setParent = () => {};
  api.destroy = () => {};
  api.haveMore = () => {};
  api.print = () => {};
  return api;
};
