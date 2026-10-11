'use strict';
// Records what the plugin appends, mirroring res/ecmascript/modules/movian/page.js.

function makeItem(page, url, type, metadata) {
  const item = {
    url, type,
    metadata: Object.assign({}, metadata),
    root: { url, type, metadata: Object.assign({}, metadata), playcount: undefined, restartpos: undefined },
    options: [],
    addOptAction(title, func, subtype) { const n = { title, func, subtype, kind: 'action' }; item.options.push(n); return n; },
    addOptURL(title, url2, subtype) { item.options.push({ title, url: url2, subtype, kind: 'url' }); },
    addOptSeparator(title) { item.options.push({ title, kind: 'separator' }); },
    destroy() { const i = page.items.indexOf(item); if(i >= 0) page.items.splice(i, 1); },
    onEvent() {}
  };
  // keep root.metadata and metadata in sync for assertions
  item.root.metadata = item.metadata;
  return item;
}

function newPage(world, url, extra) {
  extra = extra || {};
  const page = { url, items: [], options: [], exception: null, redirectedTo: null, errorMsg: null, haveMoreFlag: null, paginator: null, asyncPaginator: null, sourceUrl: null };
  const model = { metadata: {}, contents: null, loading: true, type: null };
  const root = { how: extra.how || '', zombie: false, url };
  const optGroup = {
    createMultiOpt(id, title, options, cb) { page.options.push({ id, title, options, kind: 'multiopt' }); let init = null; options.forEach(o => { if(o[2]) init = o[0]; }); cb(init !== null ? init : options[0][0]); },
    createBool(id, title, def, cb) { page.options.push({ id, title, def, kind: 'bool' }); cb(def); },
    createAction(id, title, cb) { page.options.push({ id, title, cb, kind: 'action' }); },
    createString(id, title, def, cb) { page.options.push({ id, title, def, kind: 'string' }); cb(def); },
    createDivider(title) { page.options.push({ title, kind: 'divider' }); }
  };
  const api = {
    root,
    model,
    sync: !!extra.sync,
    options: optGroup,
    get type() { return model.type; }, set type(v) { model.type = v; },
    get loading() { return model.loading; }, set loading(v) { model.loading = v; },
    get metadata() { return model.metadata; },
    get source() { return page.sourceUrl; }, set source(v) { page.sourceUrl = v; },
    entries: 0,
    set paginator(fn) { page.paginator = fn; }, get paginator() { return page.paginator; },
    set asyncPaginator(fn) { page.asyncPaginator = fn; }, get asyncPaginator() { return page.asyncPaginator; },
    haveMore(v) { page.haveMoreFlag = v; },
    appendItem(u, type, metadata) { const it = makeItem(page, u, type, metadata); page.items.push(it); return it; },
    appendPassiveItem(type, data, metadata) { const it = makeItem(page, '', type, metadata); it.data = data; it.passive = true; page.items.push(it); return it; },
    appendAction(title, func, subtype) { const it = makeItem(page, '', 'action', { title }); it.func = func; it.subtype = subtype; page.items.push(it); return it; },
    error(msg) { model.loading = false; model.type = 'openerror'; page.errorMsg = String(msg); },
    redirect(u) { page.redirectedTo = u; },
    flush() { page.items.length = 0; },
    getItems() { return page.items.slice(0); },
    dump() {},
    onEvent() {}
  };
  page.api = api;
  page.model = model;
  // Fetch every remaining page like a user scrolling to the end.
  page.drain = function(max) {
    let n = 0;
    while(page.haveMoreFlag && typeof page.paginator === 'function' && n < (max || 100)) {
      page.haveMoreFlag = !!page.paginator();
      n++;
    }
    return n;
  };
  return page;
}

exports.newPage = newPage;

exports.create = function(world) {
  function Route(re, callback) {
    const rx = new RegExp(re[0] === '^' ? re : '^' + re);
    this.re = rx;
    this.callback = callback;
    world.routes.push(this);
  }
  Route.prototype.destroy = function() {};
  function Searcher(title, icon, callback) {
    this.title = title;
    this.callback = callback;
    world.searchers.push(this);
  }
  Searcher.prototype.destroy = function() {};
  return { Route, Searcher };
};
