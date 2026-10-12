/*
 * movian-plex: playback decision.
 *
 * decide(item, opts) is a pure function: Plex metadata item (JSON) plus user
 * settings in, playback plan out. No Movian or HTTP calls, so it is unit
 * tested under Node against test/fixtures.
 *
 * PS3 hardware limits (Cell VDEC via Movian): H.264 8-bit 4:2:0 up to
 * 1920x1080, level <= 4.1; MPEG-2/MPEG-4 part 2/VC-1 up to 1080p.
 * HEVC, 10-bit, 4K, AV1, VP9 must be transcoded by the server.
 */
'use strict';

var util = require('lib/util');

var QUALITIES = [
  { id: 'original', title: 'Original (direct play)', bitrate: 0, res: null },
  { id: '1080_20', title: '1080p 20 Mbps', bitrate: 20000, res: '1920x1080' },
  { id: '1080_12', title: '1080p 12 Mbps', bitrate: 12000, res: '1920x1080' },
  { id: '1080_8', title: '1080p 8 Mbps', bitrate: 8000, res: '1920x1080' },
  { id: '720_4', title: '720p 4 Mbps', bitrate: 4000, res: '1280x720' },
  { id: '720_2', title: '720p 2 Mbps', bitrate: 2000, res: '1280x720' },
  { id: '480_1.5', title: '480p 1.5 Mbps', bitrate: 1500, res: '720x480' }
];
exports.QUALITIES = QUALITIES;
exports.DEFAULT_TRANSCODE_QUALITY = '1080_12';

// PS3 Cell VDEC safe ceilings. A stream can be spec-valid H.264 8-bit 1080p
// and still black-screen or stutter on the PS3; these catch the common causes.
// Plex's own PlayStation 3 profile caps h264 video.bitrate at 15360 kbps; we
// allow headroom and transcode only well above it, since the usual culprit is
// a 30-80 Mbps remux the PS3 cannot stream smoothly off USB/LAN.
exports.DIRECT_MAX_VIDEO_KBPS = 20000;   // auto mode: direct h264 above this -> transcode
exports.DIRECT_MAX_REF_FRAMES = 4;       // many reference frames at HD overrun the decoder


var DIRECT_CONTAINERS = ['mkv', 'mp4', 'm4v', 'mov', 'avi', 'mpegts', 'ts', 'mpeg', 'mpg'];
var DIRECT_AUDIO = ['aac', 'ac3', 'eac3', 'dca', 'dts', 'mp3', 'mp2', 'pcm', 'pcm_s16le',
                    'pcm_s16be', 'pcm_s24le', 'lpcm', 'flac'];
var DIRECT_VIDEO_OTHER = ['mpeg2video', 'mpeg1video', 'mpeg4', 'vc1', 'msmpeg4v3', 'msmpeg4'];

exports.qualityById = function(id) {
  for(var i = 0; i < QUALITIES.length; i++) if(QUALITIES[i].id === id) return QUALITIES[i];
  return QUALITIES[0];
};

function lc(s) {
  return String(s === undefined || s === null ? '' : s).toLowerCase();
}

function num(v, def) {
  var n = parseFloat(v);
  return isNaN(n) ? def : n;
}

function splitStreams(part) {
  var out = { video: null, audio: [], subtitles: [] };
  var streams = (part && part.Stream) || [];
  for(var i = 0; i < streams.length; i++) {
    var s = streams[i];
    if(s.streamType === 1 && !out.video) out.video = s;
    else if(s.streamType === 2) out.audio.push(s);
    else if(s.streamType === 3) out.subtitles.push(s);
  }
  return out;
}
exports.splitStreams = splitStreams;

function videoVerdict(stream, media) {
  var codec = lc((stream && stream.codec) || (media && media.videoCodec));
  var height = num(stream && stream.height, num(media && media.height, 0));
  var width = num(stream && stream.width, num(media && media.width, 0));
  var bitDepth = num(stream && stream.bitDepth, 8);
  var profile = lc(stream && stream.profile);
  var level = stream && stream.level !== undefined && stream.level !== null ? num(stream.level, 0) : null;
  var fps = num(stream && stream.frameRate, 0);
  var scan = lc(stream && stream.scanType);
  var chroma = String((stream && stream.chromaSubsampling) || '').replace(/\s/g, '');
  var refFrames = stream && stream.refFrames !== undefined && stream.refFrames !== null ? num(stream.refFrames, 0) : 0;

  if(!codec) return { ok: false, reason: 'unknown video codec' };
  if(height > 1080 || width > 1920) return { ok: false, reason: 'resolution ' + width + 'x' + height + ' above 1080p' };
  if(bitDepth > 8) return { ok: false, reason: bitDepth + '-bit video' };
  if(scan === 'interlaced') return { ok: false, reason: 'interlaced video (PS3 cannot deinterlace)' };
  if(chroma && chroma !== '4:2:0') return { ok: false, reason: chroma + ' chroma (only 4:2:0)' };

  if(codec === 'h264') {
    if(/high ?10|422|444|high ?4:2:2|high ?4:4:4/.test(profile)) return { ok: false, reason: 'h264 profile ' + profile };
    if(level !== null && level > 41) return { ok: false, reason: 'h264 level ' + (level / 10) + ' above 4.1' };
    if(level === null && height > 720 && fps > 31) return { ok: false, reason: '1080p above 30 fps' };
    if(refFrames > exports.DIRECT_MAX_REF_FRAMES && height > 576) return { ok: false, reason: refFrames + ' reference frames at ' + height + 'p' };
    return { ok: true, reason: 'h264 ' + width + 'x' + height + ' 8-bit' };
  }
  if(util.contains(DIRECT_VIDEO_OTHER, codec)) return { ok: true, reason: codec + ' ' + width + 'x' + height };
  return { ok: false, reason: 'video codec ' + codec };
}
exports.videoVerdict = videoVerdict;

function audioVerdict(streams, media) {
  if(!streams.length) {
    var mc = lc(media && media.audioCodec);
    if(!mc) return { ok: true, reason: 'no audio' };
    return util.contains(DIRECT_AUDIO, mc) ? { ok: true, reason: mc } : { ok: false, reason: 'audio codec ' + mc };
  }
  // The stream Plex marks as selected is what will be played by default.
  var sel = null;
  for(var i = 0; i < streams.length; i++) if(streams[i].selected) { sel = streams[i]; break; }
  if(!sel) sel = streams[0];
  var codec = lc(sel.codec);
  if(util.contains(DIRECT_AUDIO, codec)) return { ok: true, reason: codec };
  return { ok: false, reason: 'audio codec ' + codec };
}
exports.audioVerdict = audioVerdict;

function containerVerdict(part, media) {
  var c = lc((part && part.container) || (media && media.container));
  if(!c) return { ok: false, reason: 'unknown container' };
  return util.contains(DIRECT_CONTAINERS, c) ? { ok: true, reason: c } : { ok: false, reason: 'container ' + c };
}
exports.containerVerdict = containerVerdict;

function evaluateMedia(media, mediaIndex) {
  var part = (media.Part && media.Part[0]) || {};
  var st = splitStreams(part);
  var v = videoVerdict(st.video, media);
  var a = audioVerdict(st.audio, media);
  var c = containerVerdict(part, media);
  var reasons = [];
  if(!v.ok) reasons.push(v.reason);
  if(!a.ok) reasons.push(a.reason);
  if(!c.ok) reasons.push(c.reason);
  return {
    mediaIndex: mediaIndex,
    partIndex: 0,
    media: media,
    part: part,
    streams: st,
    videoOk: v.ok,
    audioOk: a.ok,
    containerOk: c.ok,
    directOk: v.ok && a.ok && c.ok,
    reason: reasons.length ? reasons.join(', ') : v.reason + ' / ' + a.reason + ' / ' + c.reason,
    height: num(media.height, 0),
    videoKbps: num(st.video && st.video.bitrate, num(media.bitrate, 0))
  };
}
exports.evaluateMedia = evaluateMedia;

function externalSubtitles(streams) {
  var out = [];
  for(var i = 0; i < streams.length; i++) {
    var s = streams[i];
    if(!s.key) continue; // only sidecar / extracted text subtitles are fetchable
    out.push({
      id: s.id,
      key: s.key,
      format: lc(s.format || s.codec),
      language: s.language || s.languageCode || '',
      languageCode: s.languageCode || '',
      title: s.displayTitle || s.title || s.language || ('Subtitle ' + s.id),
      selected: !!s.selected
    });
  }
  return out;
}

/**
 * opts:
 *   mode:          'auto' | 'direct' | 'transcode'   (Settings > Playback mode)
 *   quality:       QUALITIES[].id                    ('original' = direct when possible)
 *   burnSubtitles: boolean
 *   offsetMs:      resume position in ms (0 = from start)
 */
exports.decide = function(item, opts) {
  opts = opts || {};
  var mode = opts.mode || 'auto';
  var quality = exports.qualityById(opts.quality || 'original');
  var offsetMs = Math.max(0, util.toInt(opts.offsetMs, 0));
  var medias = (item && item.Media) || [];

  if(!medias.length) return { mode: 'none', reason: 'item has no media', ratingKey: item && item.ratingKey };

  var cands = [];
  for(var i = 0; i < medias.length; i++) cands.push(evaluateMedia(medias[i], i));

  // Prefer a version that direct plays; among several, the largest picture.
  var best = null, j;
  for(j = 0; j < cands.length; j++)
    if(cands[j].directOk && (!best || cands[j].height > best.height)) best = cands[j];
  var chosen = best || cands[0];

  var plan = {
    ratingKey: String(item.ratingKey),
    type: item.type,
    title: item.title,
    duration: util.toInt(item.duration, 0),
    mediaIndex: chosen.mediaIndex,
    partIndex: chosen.partIndex,
    partId: chosen.part.id,
    partKey: chosen.part.key,
    container: lc(chosen.part.container || chosen.media.container),
    video: chosen.streams.video,
    audioStreams: chosen.streams.audio,
    subtitleStreams: chosen.streams.subtitles,
    externalSubtitles: externalSubtitles(chosen.streams.subtitles),
    offsetMs: offsetMs,
    quality: quality.id,
    directEligible: chosen.directOk,
    transcode: null,
    reason: ''
  };

  function tc(directStream, why) {
    var q = quality;
    if(q.id === 'original') q = exports.qualityById(exports.DEFAULT_TRANSCODE_QUALITY);
    plan.mode = directStream ? 'directstream' : 'transcode';
    plan.transcode = {
      directStream: !!directStream,
      maxVideoBitrate: directStream ? 0 : q.bitrate,
      videoResolution: directStream ? null : q.res,
      burnSubtitles: !!opts.burnSubtitles,
      offsetSec: Math.floor(offsetMs / 1000)
    };
    plan.reason = why;
    return plan;
  }

  if(mode === 'transcode') return tc(false, 'Playback mode = Always transcode');
  if(quality.id !== 'original' && mode !== 'direct') return tc(false, 'quality ' + quality.title + ' selected');

  if(chosen.directOk && mode === 'auto' && chosen.videoKbps > exports.DIRECT_MAX_VIDEO_KBPS)
    return tc(false, 'video bitrate ' + Math.round(chosen.videoKbps / 1000) + ' Mbps above the direct-play ceiling; transcoding for smooth playback');

  if(chosen.directOk) {
    if(offsetMs > 0 && mode !== 'direct')
      return tc(true, 'resume at ' + util.fmtClock(offsetMs) + ': server remux (video copied, not re-encoded)');
    plan.mode = 'direct';
    plan.reason = 'direct play: ' + chosen.reason + (offsetMs > 0 ? ' (Always direct play: starting from the beginning)' : '');
    return plan;
  }

  if(mode === 'direct') {
    plan.mode = 'direct';
    plan.reason = 'Playback mode = Always direct play (' + chosen.reason + ')';
    return plan;
  }

  if(chosen.videoOk && chosen.containerOk !== false && !chosen.audioOk)
    return tc(true, 'audio needs conversion: ' + chosen.reason);
  if(chosen.videoOk && !chosen.containerOk)
    return tc(true, 'container needs remux: ' + chosen.reason);
  return tc(false, 'transcode: ' + chosen.reason);
};

/** Audio item (music track): always the raw file URL. */
exports.decideAudio = function(item) {
  var medias = (item && item.Media) || [];
  var part = medias.length && medias[0].Part && medias[0].Part[0];
  if(!part) return null;
  return { mode: 'direct', partKey: part.key, container: lc(part.container || medias[0].container), ratingKey: String(item.ratingKey) };
};
