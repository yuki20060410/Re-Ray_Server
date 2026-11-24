// 端末から届いた WAV を確かめる(端末からの依頼 §4.3: 16kHz・16 ビット・モノラル・圧縮なし、最長 15 秒)
//
// 中身(音)はここでは触らない。ヘッダを読んで、形と長さだけを確かめる。2026-11-24 作成

/** 1 回の長さの上限(端末は 15 秒で止める。少し余裕を持たせる) */
export const VOICE_MAX_MS = 16_000;
/** 受け付ける大きさの上限(16kHz・16 ビット・モノラルの 16 秒 = 512KB + ヘッダ) */
export const VOICE_MAX_BYTES = 600 * 1024;

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationMs: number;
}

export class WavError extends Error {}

/**
 * WAV(RIFF / WAVE、PCM)のヘッダを読む。形が違えば WavError。
 * 端末の都合で sampleRate・channels が変わっても文字起こしはできるので、PCM 16 ビットなら受け付ける
 */
export function readWav(buf: Uint8Array): WavInfo {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    throw new WavError("WAV ではありません(RIFF / WAVE のヘッダが無い)");
  }
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataBytes: number | null = null;

  // チャンクを順に読む(fmt と data のあいだに LIST などが入ることがある)
  for (let off = 12; off + 8 <= b.length; ) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > b.length) throw new WavError("fmt チャンクが短い");
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bitsPerSample: b.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      // 録音しながら書く端末は、data の大きさを後から書き直せないことがある。そのときは残り全部を data とする
      dataBytes = size === 0 || size === 0xffffffff || body + size > b.length ? b.length - body : size;
      break;
    }
    off = body + size + (size % 2); // チャンクは 2 バイト境界にそろう
  }

  if (!fmt) throw new WavError("fmt チャンクが無い");
  if (dataBytes === null) throw new WavError("data チャンクが無い");
  if (fmt.format !== 1) throw new WavError(`圧縮した WAV は受け付けません(形式 ${fmt.format}。PCM = 1 のみ)`);
  if (fmt.bitsPerSample !== 16) throw new WavError(`16 ビットの WAV だけ受け付けます(${fmt.bitsPerSample} ビット)`);
  if (fmt.channels < 1 || fmt.channels > 2) throw new WavError(`モノラルかステレオだけ受け付けます(${fmt.channels})`);
  if (fmt.sampleRate < 8000 || fmt.sampleRate > 48000) throw new WavError(`サンプリング周波数が範囲外です(${fmt.sampleRate})`);

  const bytesPerSec = fmt.sampleRate * fmt.channels * 2;
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: 16,
    durationMs: Math.round((dataBytes / bytesPerSec) * 1000),
  };
}

/** テストと疑似端末用: 無音または正弦波の WAV を作る(16 ビット・モノラル) */
export function makeWav(durationMs: number, sampleRate = 16000, toneHz = 0): Buffer {
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // モノラル
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(samples * 2, 40);
  if (toneHz > 0) {
    for (let i = 0; i < samples; i++) {
      b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * toneHz * i) / sampleRate) * 8000), 44 + i * 2);
    }
  }
  return b;
}
