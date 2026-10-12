# NOTES — decisions, deviations, and what is untested on hardware

Ranked by risk to a first run on a real PS3.

## Highest risk: untested on actual PS3 hardware

Everything was validated against a **real Plex Media Server** (Plex
1.43.4) and the plugin was run end-to-end under Node stand-ins for the
Movian `movian/*` / `native/*` modules (`test/shim/`). The shims mirror the
documented behaviour of the real modules (see `docs/movian-api.md` with source
citations), but they are not the Cell hardware. The following can only be
finally confirmed on the console; each has a one-line mitigation already in the
plugin or in the troubleshooting table:

1. **HLS seeking during a transcode.** Movian's HLS backend builds a seekable
   timeline only for a VOD playlist (one that ends with `#EXT-X-ENDLIST`).
   The live tests assert Plex's `start.m3u8` → variant playlist **does** carry
   `#EXT-X-ENDLIST` (`test/live/server.test.js`), so native seeking should
   work. If a given server emits a live-style playlist instead, seeking inside
   a transcode may not work; the resume path still works because it restarts
   the session with `offset=` (verified: `decide.js` emits `offset` and the
   live test checks the segment start time moves). Risk: medium.
2. **Direct-play of real files end to end.** The decision logic and the file
   URL are unit- and live-tested, and an HTTP Range request on a real part is
   verified (206, correct `Content-Range`). `decide.js` now routes the stream
   features that make a spec-valid H.264 file black-screen or stutter on the
   Cell decoder to the server transcoder in auto mode: interlaced
   (`scanType`), non-4:2:0 chroma (`chromaSubsampling`), more than four
   reference frames at >=720p (`refFrames`), and any direct video above
   20 Mbps (`DIRECT_MAX_VIDEO_KBPS`, which also fixes stutter on large
   remuxes). All four are covered by unit tests, and *Always direct play*
   still overrides them. Whether the decoder renders every remaining "direct"
   file is the one thing only the TV shows; each video item now has a
   one-press **Force transcode** option (Square) and the global *Always
   transcode* mode as recovery. Note: Movian does not auto-switch between the
   `sources` in a `videoparams` on a silent decode failure (`vs_cmp` sorts by
   bitrate and nothing emits `EVENT_REOPEN` automatically —
   `src/video/video_playback.c`), so recovery is the conservative
   classification plus the one-press override, not a hidden fallback source.
   Risk: low-medium.
3. **Controller mapping in the player.** Taken from
   `src/ui/glw/glw_ps3.c:622-663` and written into the README, not pressed on a
   real pad. Risk: low (it is Movian's own player, not ours).

## Deviations from the one-shot prompt (reality won)

* **Client profile string.** The prompt's `X-Plex-Client-Profile-Extra` sketch
  was refined empirically against the live server (Phase 0/3). The working form
  is `add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac&subtitleCodec=&replace=true)`
  plus `add-limitation` directives for `video.level<=41`, `video.bitDepth<=8`
  (scope `videoCodec`) and `audio.channels<=2` (scope **`videoAudioCodec`**).
  An earlier attempt used `scope=videoTranscodeTarget` for the audio limit;
  Plex rejects that as "missing or invalid context parameter" and then fails
  the **whole** request with HTTP 400. A segment of the resulting stream was
  pulled and ffprobe-checked: `h264 Main, yuv420p (8-bit), level 41,
  1920x1080, aac` — recorded in `test/live/server.test.js`
  ("transcode: HLS session yields h264 8-bit + aac").
* **Playback position *is* observable**, so the prompt's `/:/scrobble`-only
  fallback was not needed. The plugin reports a real Plex `/:/timeline` every
  10 s and on pause/stop, driven by the `movian/videoscrobbler` hook which
  exposes `mp.currenttime` and `mp.playstatus`
  (`es_scrobble.c`, `video_playback.c:1002`). The live test writes a timeline
  and reads the changed `viewOffset` back, then restores it.
* **Resume uses a server remux, not raw direct play.** Movian cannot tell a
  plain file source to start at an offset, so when the user resumes a
  direct-play file the plugin asks Plex for an HLS session with
  `directStream=1` (video copied, audio/container remuxed) and `offset=`. This
  is the `directstream` mode in `decide.js`. Starting from the beginning still
  uses the raw file URL with native Range seeking.
* **Two libraries, A-Z, filters, sort, recent searches, pin/reorder** were all
  implemented as the prompt asked and live-tested. Every filter/sort parameter
  was verified against the live server; `sort=random` and the full
  genre/year/decade/contentRating/resolution/collection/actor/director set are
  accepted. Note Plex ignores an *unknown* query parameter silently (returns
  200), so a wrong filter name fails open (shows unfiltered) rather than
  erroring — acceptable, and all names used here are verified.

## Desktop Movian build (Phase 3 step 5) — attempted, not completed

Building desktop Movian in this container was attempted four times and
**skipped within the timebox**, exactly where each failed:

1. libav assembler error (`mathops.h:125 operand type mismatch for 'shr'`) on
   this GCC/binutils → retried with `--disable-inline-asm` for libav.
2. rtmpdump failed (`hashswf.c` OpenSSL `HMAC_close`) → retried with
   `--disable-librtmp`.
3. vmir failed (`vmir.c:881 conflicting types for 'vmir_load'`) and `-Werror`
   turned several upstream warnings fatal → retried with vmir disabled and
   `-Werror` removed.
4. Reached the GUI: `src/arch/linux/linux_main.c:21: fatal error:
   gdk/gdkkeysyms.h: No such file or directory` — the desktop GUI target needs
   GTK2 dev headers (`libgtk2.0-dev`), which are not installable in this
   sandbox.

The 2019 upstream desktop target does not build cleanly on a 2024 toolchain
without GTK2, and that is orthogonal to the plugin. Instead of a headless GUI
load, the plugin is exercised directly through the Movian module shims against
a live server (`npm test`), which covers more of the plugin's own logic than a
`plex:start` smoke-render would. To finish the GUI build on a matching host:
install `libgtk2.0-dev` and the other deps from
`ref/movian/README.markdown`, then
`./configure --disable-webkit --disable-vdpau --disable-avahi && make`, and run
`build.linux/movian -d --ecmascript plugin/plugin.js`.

## Smaller notes

* **ES5 only.** Enforced two ways: an ESLint flat config pinned to
  `ecmaVersion: 5` that also bans arrow functions, `let/const`, template
  literals, classes, destructuring and the ES6+ `Array`/`String` methods
  Duktape lacks; and `test/es5gate.js`, which parses every plugin file with
  espree at ES5 and then loads each under the shims to catch top-level runtime
  errors. The M7 self embeds Duktape 1.8, upstream 1.5 — both ES5.
* **Store shape.** `movian/store` only proxies the top level, so all
  structured state (library prefs, per-library view state, recent searches) is
  kept as JSON strings under single keys. The client id is generated once and
  persisted.
* **Secrets.** No token is committed. Tests read `.env` (git-ignored); the
  fixtures captured from the live server are scrubbed of file paths, tokens and
  machine identifiers by `test/fixtures/capture.py`.
* **Shared vs owned servers.** Discovery keeps a per-server access token when
  plex.tv returns one for a shared server; otherwise the account token is used.
  Only plain-`http` LAN connections are offered to the PS3 (its TLS is too old
  for `*.plex.direct` https); `local=true` private-IP addresses are probed
  first via `/identity` with a timeout.
* **plex.tv fail-soft + on-TV entry.** Every plex.tv call is `noFail` and
  wrapped; if the PIN flow or resource list cannot be reached the UI shows the
  `get_token.py` instructions. Both the PIN screen and that fallback now also
  offer **Enter server address on this TV** and **Enter a Plex token on this
  TV** (controller text dialogs that validate against the server and redirect
  home on success), so a PS3 whose TLS cannot reach plex.tv never has to leave
  the plugin for Settings. Live-tested: the link page renders a code or the
  helper text and always carries both on-TV entry actions, and driving the
  server-entry action against the live server resolves to the home page or the
  link page as appropriate.
