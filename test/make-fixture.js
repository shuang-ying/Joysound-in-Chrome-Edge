'use strict';
// 生成本地测试用的音频素材（WAV：视频元素可以直接播放纯音频文件）
const fs = require('fs');
const path = require('path');

const RATE = 44100;
const SECONDS = 6;
const CHANNELS = 2;

function makeWav(file) {
  const frames = RATE * SECONDS;
  const dataBytes = frames * CHANNELS * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * CHANNELS * 2, 28);
  buf.writeUInt16LE(CHANNELS * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < frames; i++) {
    const t = i / RATE;
    // 两个音高交替，方便听出「有处理 / 没处理」
    const f = t % 2 < 1 ? 440 : 523.25;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.5 * t);
    const sample =
      Math.sin(2 * Math.PI * f * t) * 0.45 + Math.sin(2 * Math.PI * f * 2 * t) * 0.12;
    const v = Math.max(-1, Math.min(1, sample * env)) * 0.7;
    const int = Math.round(v * 32767);
    buf.writeInt16LE(int, 44 + i * 4);
    buf.writeInt16LE(int, 44 + i * 4 + 2);
  }

  fs.writeFileSync(file, buf);
  return buf.length;
}

module.exports = { makeWav };

if (require.main === module) {
  const out = path.join(__dirname, 'fixture', 'tone.wav');
  const size = makeWav(out);
  console.log('wrote', out, size, 'bytes');
}
