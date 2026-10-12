'use strict';
// Unit tests for plugin/lib/decide.js against fixtures captured from a real
// Plex Media Server (test/fixtures/capture.py).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const env = require('../shim/loader').create({});
const decide = env.require('lib/decide');

function fx(name) {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name + '.json'), 'utf8'));
  return j.Metadata ? j.Metadata[0] : j;
}

test('h264 8-bit 1080p mkv with aac -> direct play', () => {
  const plan = decide.decide(fx('metadata_h264_8bit_1080p'), { mode: 'auto', quality: 'original' });
  assert.strictEqual(plan.mode, 'direct');
  assert.ok(plan.partKey.indexOf('/library/parts/') === 0, plan.partKey);
  assert.strictEqual(plan.container, 'mkv');
  assert.ok(plan.directEligible);
  assert.strictEqual(plan.externalSubtitles.length, 1, 'sidecar srt is exposed');
  assert.strictEqual(plan.externalSubtitles[0].format, 'srt');
  assert.strictEqual(plan.audioStreams.length, 2);
});

test('HEVC 10-bit 4K -> transcode at default 1080p 12 Mbps', () => {
  const plan = decide.decide(fx('metadata_hevc_10bit_4k'), { mode: 'auto', quality: 'original' });
  assert.strictEqual(plan.mode, 'transcode');
  assert.strictEqual(plan.transcode.directStream, false);
  assert.strictEqual(plan.transcode.maxVideoBitrate, 12000);
  assert.strictEqual(plan.transcode.videoResolution, '1920x1080');
  assert.ok(/above 1080p|10-bit|hevc/.test(plan.reason), plan.reason);
});

test('h264 10-bit (High 10) -> transcode', () => {
  const plan = decide.decide(fx('metadata_h264_10bit'), { mode: 'auto', quality: 'original' });
  assert.strictEqual(plan.mode, 'transcode');
  assert.ok(/10-bit|high 10/.test(plan.reason), plan.reason);
});

test('mpeg2 program stream -> direct play', () => {
  const plan = decide.decide(fx('metadata_mpeg2'), { mode: 'auto', quality: 'original' });
  assert.strictEqual(plan.mode, 'direct');
  assert.ok(/mpeg2video/.test(plan.reason), plan.reason);
});

test('multi-version item picks the version that direct plays', () => {
  // Synthetic: HEVC version first, h264 version second.
  const hevc = fx('metadata_hevc_10bit_4k');
  const h264 = fx('metadata_h264_8bit_1080p');
  const item = Object.assign({}, hevc, { Media: [hevc.Media[0], h264.Media[0]] });
  const plan = decide.decide(item, { mode: 'auto', quality: 'original' });
  assert.strictEqual(plan.mode, 'direct');
  assert.strictEqual(plan.mediaIndex, 1);
  assert.strictEqual(plan.partKey, h264.Media[0].Part[0].key);
});

test('audio-only track -> raw part URL', () => {
  const a = decide.decideAudio(fx('album_tracks'));
  assert.strictEqual(a.mode, 'direct');
  assert.ok(/\/library\/parts\/\d+\/\d+\/file\.mp3$/.test(a.partKey), a.partKey);
});

test('resume offset on a direct-play file -> server remux (directstream) with offset', () => {
  const plan = decide.decide(fx('metadata_h264_8bit_1080p'), { mode: 'auto', quality: 'original', offsetMs: 125000 });
  assert.strictEqual(plan.mode, 'directstream');
  assert.strictEqual(plan.transcode.directStream, true);
  assert.strictEqual(plan.transcode.offsetSec, 125);
  assert.strictEqual(plan.transcode.maxVideoBitrate, 0, 'no bitrate cap when copying video');
});

test('Always direct play ignores the offset and never transcodes', () => {
  const plan = decide.decide(fx('metadata_hevc_10bit_4k'), { mode: 'direct', quality: 'original', offsetMs: 125000 });
  assert.strictEqual(plan.mode, 'direct');
});

test('Always transcode forces HLS even for a direct-play file', () => {
  const plan = decide.decide(fx('metadata_h264_8bit_1080p'), { mode: 'transcode', quality: 'original' });
  assert.strictEqual(plan.mode, 'transcode');
  assert.strictEqual(plan.transcode.maxVideoBitrate, 12000);
});

test('explicit lower quality transcodes at that quality', () => {
  const plan = decide.decide(fx('metadata_h264_8bit_1080p'), { mode: 'auto', quality: '720_4', burnSubtitles: true });
  assert.strictEqual(plan.mode, 'transcode');
  assert.strictEqual(plan.transcode.maxVideoBitrate, 4000);
  assert.strictEqual(plan.transcode.videoResolution, '1280x720');
  assert.strictEqual(plan.transcode.burnSubtitles, true);
});

test('unsupported audio with good video -> directstream (audio-only conversion)', () => {
  const item = JSON.parse(JSON.stringify(fx('metadata_h264_8bit_1080p')));
  item.Media[0].Part[0].Stream.forEach(s => { if(s.streamType === 2) { s.codec = 'truehd'; s.selected = true; } });
  const plan = decide.decide(item, { mode: 'auto', quality: 'original' });
  assert.strictEqual(plan.mode, 'directstream');
  assert.ok(/audio/.test(plan.reason));
});

test('h264 level 4.2 (1080p60) and 1080p above 30 fps without level -> transcode', () => {
  const item = JSON.parse(JSON.stringify(fx('metadata_h264_8bit_1080p')));
  const v = item.Media[0].Part[0].Stream.filter(s => s.streamType === 1)[0];
  v.level = 42;
  assert.strictEqual(decide.decide(item, {}).mode, 'transcode');
  delete v.level;
  v.frameRate = 59.94;
  assert.strictEqual(decide.decide(item, {}).mode, 'transcode');
  v.frameRate = 23.976;
  assert.strictEqual(decide.decide(item, {}).mode, 'direct');
});

test('item without media -> mode none', () => {
  assert.strictEqual(decide.decide({ ratingKey: '9', title: 'x' }, {}).mode, 'none');
});

test('quality table and helpers', () => {
  assert.strictEqual(decide.QUALITIES.length, 7);
  assert.strictEqual(decide.qualityById('nope').id, 'original');
  assert.strictEqual(decide.qualityById('480_1.5').bitrate, 1500);
});

test('PS3 decoder guards: interlaced, non-4:2:0 chroma, many ref frames -> transcode', () => {
  function mut(f) {
    const it = JSON.parse(JSON.stringify(fx('metadata_h264_8bit_1080p')));
    const v = it.Media[0].Part[0].Stream.filter(s => s.streamType === 1)[0];
    f(it, v);
    return it;
  }
  assert.strictEqual(decide.decide(mut((it, v) => v.scanType = 'interlaced'), { mode: 'auto' }).mode, 'transcode');
  assert.ok(/interlaced/.test(decide.decide(mut((it, v) => v.scanType = 'interlaced'), { mode: 'auto' }).reason));
  assert.strictEqual(decide.decide(mut((it, v) => v.chromaSubsampling = '4:2:2'), { mode: 'auto' }).mode, 'transcode');
  assert.strictEqual(decide.decide(mut((it, v) => v.refFrames = 8), { mode: 'auto' }).mode, 'transcode');
  // many ref frames are fine at SD
  assert.strictEqual(decide.decide(mut((it, v) => { v.refFrames = 8; v.height = 480; it.Media[0].height = 480; }), { mode: 'auto' }).mode, 'direct');
  // progressive 4:2:0 with few ref frames is still direct
  assert.strictEqual(decide.decide(mut((it, v) => { v.scanType = 'progressive'; v.chromaSubsampling = '4:2:0'; v.refFrames = 2; }), { mode: 'auto' }).mode, 'direct');
});

test('direct video above the bitrate ceiling transcodes in auto mode (even when resuming)', () => {
  function big(off) {
    const it = JSON.parse(JSON.stringify(fx('metadata_h264_8bit_1080p')));
    it.Media[0].bitrate = 45000;
    it.Media[0].Part[0].Stream.filter(s => s.streamType === 1)[0].bitrate = 44000;
    return decide.decide(it, { mode: 'auto', quality: 'original', offsetMs: off || 0 });
  }
  const plan = big(0);
  assert.strictEqual(plan.mode, 'transcode');
  assert.strictEqual(plan.transcode.directStream, false, 'video is re-encoded, not copied');
  assert.ok(/Mbps/.test(plan.reason), plan.reason);
  // resume on an oversized file must also re-encode, not remux (which would keep the bitrate)
  assert.strictEqual(big(120000).mode, 'transcode');
  assert.strictEqual(big(120000).transcode.offsetSec, 120);
});

test('Always direct play overrides every PS3 guard and the bitrate ceiling', () => {
  function mut(f) {
    const it = JSON.parse(JSON.stringify(fx('metadata_h264_8bit_1080p')));
    const v = it.Media[0].Part[0].Stream.filter(s => s.streamType === 1)[0];
    f(it, v);
    return it;
  }
  assert.strictEqual(decide.decide(mut((it, v) => v.scanType = 'interlaced'), { mode: 'direct' }).mode, 'direct');
  assert.strictEqual(decide.decide(mut((it, v) => { v.bitrate = 45000; it.Media[0].bitrate = 45000; }), { mode: 'direct' }).mode, 'direct');
});
