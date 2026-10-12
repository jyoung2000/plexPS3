# movian-plex

A Plex client plugin for the [Movian](https://movian.tv) media player, built
for Movian on a jailbroken PlayStation 3 (Evilnat CFW + webMAN, the M7
7.0.273 build) and equally for desktop Movian.

It signs you in with a code at **plex.tv/link** (no password typing on the
controller), lists your libraries, and plays your media: files the PS3 can
decode play directly at full quality; anything else (HEVC, 10-bit, 4K, AV1,
unsupported audio) is transcoded to PS3-friendly H.264/AAC by your Plex
server. Browsing, search, filters, sort, resume and watched-state are all
there.

```
plugin/           the plugin (ES5, Duktape) — this is what ships in plex.zip
  plugin.json     API v2 ecmascript manifest
  plugin.js       routes + UI
  lib/plexapi.js  all HTTP + Plex/plex.tv URL building (injectable transport)
  lib/decide.js   pure direct-play-vs-transcode decision
  lib/util.js     ES5 helpers
tools/            Python 3 (stdlib only): get_token, build, deploy, pull_logs
test/             Node shims + unit, live and ES5-gate tests
docs/movian-api.md  cited Movian API reference used to build this
NOTES.md          decisions, deviations, and what is untested on real hardware
dist/plex.zip     the built plugin (produced by tools/build.py)
```

## 1. Prepare (about 10 minutes)

1. **Install Movian on the PS3.** Install the M7 PS3 `.pkg` from the Package
   Manager, launch it once so it creates its settings folder, then quit.
2. **Plex server:** Settings > Network > *Secure connections* = **Preferred**
   (not Required), so the PS3 can reach it over plain HTTP on the LAN. Note the
   server's LAN IP. Optional: add the PS3's IP under *List of IP addresses and
   networks that are allowed without auth* for a no-login setup.
3. **PS3:** give it a static/reserved IP and confirm webMAN FTP works
   (`ftp://<PS3-IP>`, port 21, no login).
4. **PC (only if you want to build/deploy from source):** Node 18+ and
   Python 3. `dist/plex.zip` is already built, so you can skip this and just
   copy the zip.

## 2. Install the plugin (pick one)

**A. USB (easiest)**
1. Copy `dist/plex.zip` to a FAT32 USB stick. Do **not** unzip it.
2. Plug it into the PS3 and start Movian.
3. On the Movian home screen open the USB drive, select `plex.zip`, press
   **X** and choose **Install**.
4. Back on the home screen, Plex is there.

**B. Over the network (webMAN FTP)**
1. From your PC open an FTP client (WinSCP, FileZilla, or the Explorer address
   bar) to `ftp://<PS3-IP>` port 21, no login.
2. Go to `/dev_hdd0/game/HTSS00003/USRDIR/settings/installedplugins/`
   (create `installedplugins` if it is missing).
3. Drop `plex.zip` in. Do **not** unzip it.
4. Quit and restart Movian.

`python tools/deploy.py <PS3-IP>` does B for you (and builds first). You can
confirm the file landed with webMAN's file manager at
`http://<PS3-IP>/dev_hdd0/game/HTSS00003/USRDIR/settings/installedplugins/`.

## 3. Sign in to Plex (PIN)

1. Open **Plex** in Movian. On first run it shows a 4-character code.
2. On your phone or PC go to **plex.tv/link**, sign in and type the code.
3. The plugin finds your server on the LAN by itself and opens your libraries.
   No IP or password typing on the controller.
4. If the code screen says it cannot reach plex.tv (the PS3's TLS is old): on
   your PC run `python tools/get_token.py`, link the same way, then type the
   printed token and your server address (`http://<ip>:32400`) into
   **Movian > Settings > Plex**. One time only.

On first link the plugin shows the **Choose libraries** screen once. All
libraries are on by default; press X to toggle one, Square for Pin to home /
reorder. You can reopen it any time from the home screen or Settings > Plex.

## 4. Playing

Playback uses Movian's own player, so all of its controls work:

| Button (PS3) | During playback |
|---|---|
| Start | Play / pause |
| D-pad Left / Right | Seek back / forward |
| D-pad Up / Down | Volume up / down |
| L1 / R1 | Previous / next episode |
| Triangle | Player menu: audio track, subtitle track, subtitle on/off, aspect/zoom/stretch, A/V sync |
| Square | Media stats |
| Circle | Stop / back |
| Cross | Show/hide the on-screen playdeck |

(Mapping from `src/ui/glw/glw_ps3.c`; see docs/movian-api.md.)

Auto mode (the default) direct-plays only what the PS3 can reliably decode: progressive, 4:2:0, 8-bit H.264 up to 1080p / level 4.1 with a sane reference-frame count and a video bitrate up to 20 Mbps (plus MPEG-2/4 and VC-1). Interlaced, 10-bit, 4:2:2/4:4:4, HEVC/AV1, or very high-bitrate files are transcoded by the server to PS3-friendly H.264/AAC. Set **Playback mode = Always direct play** to override and feed the raw file regardless.

* **Quality** is a per-item menu (Square on a title, or the pre-play options):
  Original (direct play) plus 1080p/720p/480p transcode presets. Original is
  the default, so quality is as high as the PS3 can decode; transcodes default
  to 1080p 12 Mbps. Changing quality reopens the item at the new setting.
* **Audio / subtitle tracks:** during direct play use Triangle (Movian's own
  menu) to switch the file's embedded tracks. For transcodes, and to set the
  server-side default, use **Tracks** in the item menu (Square) — it sets the
  Plex `audioStreamID`/`subtitleStreamID`. Turn on *Burn subtitles when
  transcoding* in Settings > Plex if a subtitle format will not display
  otherwise.
* **Resume:** opening a part-watched item asks *Resume / Start over*. Progress
  and watched-state are reported back to Plex every 10 seconds and on stop, so
  Continue Watching and the progress bars stay in sync across your devices.

## 5. Settings reference (Settings > Plex)

| Setting | What it does |
|---|---|
| Server URL | `http://ip:32400`. Filled automatically after PIN linking; set it by hand for the token fallback. |
| Plex token | Filled by PIN linking. Set by hand only for the `get_token.py` fallback. |
| Link with plex.tv (PIN) | Start the code flow. |
| Discover servers | Re-run server discovery for your account. |
| Choose libraries | Toggle / pin / reorder which libraries appear. |
| Sign out | Forget the token. |
| Playback mode | Auto (default), Always direct play, Always transcode. |
| Quality | Original (direct) or a transcode preset. |
| Burn subtitles when transcoding | Render subtitles into the video. |
| Debug logging | Log every request (token redacted) to the Movian log. |

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| "No servers found" after linking | Set Plex > Network > Secure connections = **Preferred**, and make sure the PS3 and server are on the same LAN. Or set the Server URL by hand in Settings > Plex. |
| plex.tv link screen cannot reach plex.tv | The link screen now offers **Enter server address on this TV** and **Enter a Plex token on this TV** — run `python tools/get_token.py` on your PC for the token, type it and the server address with the controller, and you are in without leaving the plugin. |
| 401 / "token rejected" | The token expired or you signed out elsewhere. Open Plex and link again (Settings > Plex > Link with plex.tv). |
| Black screen / no video on play | Auto mode now routes interlaced, non-4:2:0 and high-reference-frame H.264 to the server transcoder, so this is rare. If a file still black-screens, press Square on it and choose **Force transcode**, or set **Playback mode = Always transcode**. |
| Stutter / buffering | Auto mode transcodes any direct file whose video bitrate is above 20 Mbps, so big remuxes play smoothly by default. If it still stutters, lower **Quality** (e.g. 720p 4 Mbps). To force raw playback of a high-bitrate file, set **Playback mode = Always direct play**. |
| No audio on a transcode | The server is sending >2-channel audio; the plugin forces stereo AAC, but if it persists set Quality to a transcode preset so audio is re-encoded. |
| Subtitles missing on a transcode | Turn on *Burn subtitles when transcoding* in Settings > Plex. |
| Collect a log | `python tools/pull_logs.py <PS3-IP>` (turn on Debug logging first), then paste the output. |

## Building and testing from source

```
npm install          # dev-only: eslint (the plugin itself has no deps)
npm test             # eslint (ES5) + ES5 gate + unit tests + live tests
python tools/build.py        # -> dist/plex.zip
python tools/deploy.py <IP>  # build + FTP to the PS3
```

Live tests need a reachable server: put `PMS_URL=http://ip:32400` and
`PLEX_TOKEN=...` in a git-ignored `.env` (see `tools/get_token.py`). Without
`.env` the live tests skip and the rest still run. `test/fixtures/capture.py`
regenerates the unit-test fixtures from a live server.

See `docs/movian-api.md` for the cited Movian API this is built on and
`NOTES.md` for design decisions and what remains untested on real PS3 hardware.
