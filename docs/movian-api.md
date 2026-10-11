# Movian API ground truth (for movian-plex)

All citations are to the Movian source. Two trees were read:

* **Upstream** `andoma/movian` at commit `65c22dd` (`ref/movian/`), the
  canonical source for the ecmascript (API v2) modules and the PS3 arch code.
* **M7 fork** `kolbicz/Movian` branch `M7` at commit `c84de38` (`ref/movian-m7/`),
  the base of the PS3 M7 7.0.273 build you uploaded.

The M7 `.pkg` you provided (`movianM7-7.0.273-playstation3.pkg`, content id
`UP0001-HTSS00003_00`) was unpacked and its embedded `movian.self` scanned:
its `res/ecmascript/modules/movian/*.js` are byte-identical to upstream except
for whitespace and two additions (`Page.prototype.openurl`, a `no_meta_bind`
guard in `appendItem`) — see **Differences in the M7 build** below. So the
upstream module sources are authoritative for this plugin. Duktape version in
the M7 self is 1.8 (`DUK_VERSION 10800`), upstream is 1.5 (`10500`); both are
strict ES5 engines.

## plugin.json (API v2 ecmascript plugin)

Parsed in `src/plugins.c`. Fields read (`plugin_load`, lines ~560-730):

| field | required | notes |
|---|---|---|
| `type` | yes | must be `"ecmascript"` (`plugins.c:571,645`) |
| `id` | yes | plugin id, becomes `Plugin.id` (`plugins.c:573`) |
| `file` | yes | entry script, loaded relative to the zip root (`plugins.c:645`) |
| `apiversion` | no (default 1) | **must be 2** for the module/CommonJS runtime (`plugins.c:653`) |
| `version` | no | shown in UI; `pl_inst_ver` |
| `title` | no | defaults to `id` (`plugins.c:593`) |
| `icon` | no | relative path, resolved against `Plugin.path` |
| `category` | no | `video`, `tv`, `music`, ... (`plugins.c:390`) |
| `synopsis`, `description`, `author` | no | metadata only |
| `showtimeVersion` | no | minimum core version (`plugins.c:903`) |
| `debug` | no | sets `ECMASCRIPT_DEBUG` (`plugins.c:656`) |
| `entitlements` | no | `bypassFileACLRead/Write` (`plugins.c:659-663`) |

A plugin is installed from a **zip** whose root holds `plugin.json`
(`plugins.c:455` `zip://%s/plugin.json`, `:1591`). Movian scans
`<persistent_path>/installedplugins/*.zip` at start-up (`plugins.c:757,1416`).

## Globals available to the plugin

Set in `src/ecmascript/ecmascript.c`:

* `Plugin.id`, `Plugin.url`, `Plugin.path` (dir with trailing `/`),
  `Plugin.manifest` (plugin.json as a string), `Plugin.apiversion`
  (`ecmascript.c:894-907`).
* `Core.currentVersionInt`, `Core.currentVersionString`, `Core.deviceId`,
  `Core.storagePath` (`ecmascript.c:479-494`). On the PS3 `Core.storagePath`
  begins with `/dev_hdd0/game/HTSS00003/` — this is how the plugin detects PS3.
* `console.log/error/warn` (`es_console.c`), `print`, `setTimeout`,
  `setInterval`, `clearTimeout`, `clearInterval` (`es_timer.c:239-242`),
  `Duktape` (incl. `Duktape.fin`).

`require()` resolution (`ecmascript.c:409` `es_modsearch`):

* `native/<x>` → a C module registered with `ES_MODULE(...)`. Available
  native modules: `io, prop, popup, misc, string, htsmsg, metadata, hook,
  route, service, kvstore, sqlite, subtitle, websocket, crypto, fs, gumbo,
  stats`.
* `movian/<x>` and `showtime/<x>` (alias) → `dataroot://res/ecmascript/modules/movian/<x>.js`.
* anything else → resolved against `Plugin.path` (so `require('lib/util')`
  loads `<plugin>/lib/util.js`). `ecmascript.c:443-453`.

## movian/page  (`res/ecmascript/modules/movian/page.js`)

* `new page.Route(regexp, callback)` — register a route. The regex is anchored
  with `^` automatically (`es_route.c:107`). Capture groups become extra
  callback arguments after the `page` object (`page.js:384-406`).
* `new page.Searcher(title, icon, callback)` — register in Movian's global
  search; `callback(page, query)` (`page.js:413-447`, hook `es_searcher.c`).
* Page object:
  * `page.type` = `'directory' | 'video' | 'openerror' | ...`
  * `page.metadata.title / .icon / .logo`
  * `page.loading` (set `false` when done), `page.entries`
  * `page.source` — for a `video` page, set to a `videoparams:` URL to play
  * `page.appendItem(url, type, metadata)` → item. For `type === 'video'`,
    Movian binds play-info (playcount/restartpos) to the url
    (`page.js:263-297`, `es_metadata.c:bindPlayInfo`).
  * `page.appendPassiveItem(type, data, metadata)` — non-navigable row
  * `page.appendAction(title, fn, subtype)` — a button
  * `page.paginator = fn` / `page.asyncPaginator = fn` — called on
    `wantmorechilds`; return truthy for "more" (`page.js:202-226`). Paging
    example: `plugin_examples/async_page_load/async_page_load.js`.
  * `page.haveMore(bool)`, `page.flush()`, `page.redirect(url)`,
    `page.error(msg)` (`page.js:239-350`).
  * `page.options.create{MultiOpt,Bool,Action,String,Divider}` — the page's
    kebab menu (same API as settings; `page.js:197` wires it to
    `kvstoreSettings`).
* Item object: `item.addOptAction(title, fn, subtype)`,
  `item.addOptURL`, `item.addOptSeparator` — the item's context menu
  (Square on PS3) (`page.js:55-93`). `item.root.playcount`,
  `item.root.restartpos` drive the watched tick and resume bar in the skin
  (`glwskins/flat/items/list/video.view:46-67`).

### Playable item: the `videoparams:` URL

Parsed in `src/video/video_playback.c:283-375`. JSON after the `videoparams:`
prefix:

```json
{
  "title": "...", "canonicalUrl": "...", "icon": "...",
  "year": 2019, "season": 1, "episode": 2, "imdbid": "tt...",
  "sources":   [ { "url": "...", "mimetype": "...", "bitrate": 0 } ],
  "subtitles": [ { "url": "...", "title": "...", "language": "en", "source": "Plex" } ],
  "no_fs_scan": true, "no_subtitle_scan": true
}
```

* `sources[].url` is played directly. For HLS the URL must be prefixed with
  `hls:` so Movian's HLS backend claims it (`src/backend/hls/hls.c:2294`
  `hls_canhandle` matches `hls:`; the backend strips the prefix at `:2253`).
  A plain file URL (http) is handled by the fileaccess video backend, which
  honours HTTP Range for seeking.
* `canonicalUrl` identifies the item for play-info and is echoed to the
  scrobble hook as `canonical_url` — the plugin encodes the ratingKey and the
  session id here (`video_playback.c:291`, `es_scrobble.c`).
* `subtitles[].url` is fetched by Movian itself (srt/ass/vtt sidecars).
* `no_fs_scan` / `no_subtitle_scan` stop Movian probing the folder
  (`video_playback.c:369-373`) — always set them for network items.

A `video` **page** can instead set `page.type='video'; page.source='videoparams:...'`
and Movian waits for the source (`video_playback.c:210-245`), which is how a
route resolves playback lazily. This plugin uses that form.

## movian/http  (`modules/movian/http.js`, native `es_io.c`)

`require('movian/http').request(url, ctrl[, cb])`. `ctrl` keys actually read
(`es_io.c:305-404`): `method`, `headers` (object), `postdata`, `args`
(object → query string), and boolean flags `debug`, `noFollow`, `compression`,
`noAuth`, `noFail`, `verifySSL`, `headRequest`, plus `caching`/`cacheTime`.
With `noFail` a 4xx/5xx returns a response instead of throwing
(`FA_CONTENT_ON_ERROR`). Response: `.statuscode`, `.headers` / `.headers_lc`
(lower-cased), `.multiheaders_lc`, `.toString()` (`http.js:5-65`). A callback
makes the call async (`http.js:93-101`). **The plugin always sets `noFail` and
builds the query itself** so a dead server can never throw out of a route.

## movian/prop, service, settings, store, popup, videoscrobbler

* **prop** (`modules/movian/prop.js`, `es_prop.c`): `prop.global` is the root
  property tree. `prop.sendEvent(sink, 'openurl', {url, how})` opens a page in
  the navigator (`es_prop.c:826-860`); the navigator sink is
  `prop.global.navigators.current.eventSink` (`src/navigator.c:319`,
  `:255`). `prop.isZombie(p)` is true once a page is closed (used to stop
  timers). `prop.subscribeValue(p, cb, ctrl)`.
* **service** (`es_service.c`): `service.create(title, url, type, enabled, icon)`
  puts the plugin on the home screen.
* **settings** (`modules/movian/settings.js`): `new settings.globalSettings(id,
  title, icon, desc)` creates a page under Settings; methods `createString,
  createBool, createInt, createMultiOpt, createAction, createDivider,
  createInfo`. The group exposes `.properties.url` (a `settings:` URL) to
  navigate to it (`settings.js:283`). Each setter callback also fires once with
  the stored/initial value at creation (`settings.js:78-118`) — the plugin
  guards section-option callbacks against this initial fire.
* **store** (`modules/movian/store.js`): `store.create(name)` → a proxied
  object persisted as JSON at `<storagePath>/store/<name>`. Only the **top
  level** is proxied, so structured values are kept as JSON strings. Writes are
  debounced 5 s and flushed by a finalizer (`store.js:19-45`).
* **popup**: `require('movian/popup').notify(text, seconds)`. For blocking
  dialogs use `require('native/popup')`: `message(text, ok, cancel) -> bool`
  and `textDialog(text, ok, cancel) -> {input, rejected}` (`es_misc.c:154-231`).
* **videoscrobbler** (`modules/movian/videoscrobbler.js`, hook invoked from
  `es_scrobble.c:69`, data built in `src/video/video_playback.c:1002`):
  `new VideoScrobbler()` with `onstart/onpause/onresume/onstop(data, mp, origin)`.
  `data` has `id`, `canonical_url`, `title`, `season`, `episode`, `year`,
  `duration`, `resumeposition`, `stopposition`. `mp.currenttime` (seconds) and
  `mp.playstatus` (`'play'|'pause'`) are the live media-pipe props
  (`src/media/media.c:223-225`). **This is how the plugin observes playback
  position for Plex timeline reporting** — position *can* be observed, so the
  `/:/scrobble`-only fallback in the prompt is not needed.

## PS3 specifics

* Paths (`src/arch/ps3/ps3_main.c:440-442`): the binary lives in
  `/dev_hdd0/game/HTSS00003/USRDIR/`; `persistent_path =
  .../USRDIR/settings`, `cache_path = .../USRDIR/cache`.
  → installed plugins: `/dev_hdd0/game/HTSS00003/USRDIR/settings/installedplugins/`.
* Logs: Movian writes `<cache_path>/log/movian-N.log`
  (`src/api/httpcontrol.c:77` `%s/log/movian-%d.log`, APPNAME=`movian`), i.e.
  `/dev_hdd0/game/HTSS00003/USRDIR/cache/log/movian-0.log`. The PS3 build also
  streams trace over UDP to a dev host (`ps3_main.c:317-354`).
* Built-in HTTP server on **port 42000** (`src/networking/http_server.c:1166`).
  Useful endpoints (`src/api/httpcontrol.c:678-693`): `/api/logfile/N`
  (view/`?mode=download`), `/api/open?url=`, `/api/input/action`,
  `/api/diag`, `/showtime/*` is rewritten to `/api/*`. `tools/pull_logs.py`
  uses `/api/logfile/N` when Movian is running and FTP otherwise.
* Video decode: Cell `ps3_vdec.c`. H.264 is hardware-decoded; the client
  profile and `decide.js` keep streams within 1080p / level 4.1 / 8-bit.

## PS3 controller mapping (`src/ui/glw/glw_ps3.c:622-663`)

Default (non-select) and in-playback actions:

| Button | Action |
|---|---|
| D-pad | navigate; in video: Left/Right seek, Up/Down volume (`video.view`) |
| Cross (X) | Activate / OK |
| Circle (O) | Back / Stop |
| Triangle | Menu (audio/subtitle/settings during playback) |
| Square | Item menu (context options) / media stats |
| L1 / R1 | Skip backward / forward (previous / next) |
| Start | Play / pause |
| Select + Triangle | Switch view |
| BD-remote Play/Pause/Stop/Prev/Next/ScanFwd/ScanRev/Subtitle/Audio | mapped to the matching player actions (`glw_ps3.c:644-651`) |

## Differences in the M7 build vs upstream modules

From diffing the modules extracted from `movian.self` against upstream:

* `page.js`: adds `Page.prototype.openurl(url)` (sends a `redirect2` event) and
  guards `bindPlayInfo` with `if(!metadata.no_meta_bind)`. The plugin does not
  rely on either; it uses the standard `redirect`/`openurl`-via-navigator path
  that exists in both builds.
* `store.js`: two `console.log` lines commented out. No behavioural change.
* All other modules differ only by trailing whitespace / the zip `PK` marker
  captured during extraction.

Conclusion: the plugin targets the common API and runs on upstream desktop
Movian and the M7 PS3 build alike.
