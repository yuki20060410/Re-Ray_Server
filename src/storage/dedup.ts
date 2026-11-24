// 定型信号の重複の判定(ARCHITECTURE §6)。メモリ版と MySQL 版の両方がこれを使う
//
// 2026-11-24 見直し(端末からの依頼 2026-11-20 #2):
//   前は「同じ端末・同じ seq が 10 分以内」だけで判定していた。端末は「本部に届いた」が来ない信号を取っておき、
//   つながったときに**同じ seq・同じ ts で**送り直す。10 分を過ぎた送り直しが新しい信号として記録され、
//   SOS が 2 件に見えることがあった。
//
// 今の決まり: 同じ端末・同じ seq で、受信時刻の差が resendWindowMs(24 時間)以内のとき、
//   - 両方に端末の時刻(ts)がある → ts が同じなら同じ信号(送り直し)。ts が違えば別の信号
//     (再起動で seq が乱数から始まり、たまたま前と同じ seq になった場合)
//   - どちらかに ts が無い(時刻が合っていない端末)→
//       windowMs(10 分)以内なら同じ信号(QoS 1 の再配信、Wi-Fi と LoRa の両方から届いた分。今までと同じ)
//       それより後は、中身(code・pos・n・dir)が同じときだけ同じ信号
// 端末には「送り直すときは、seq も ts も最初の値のまま送る」ことを頼む(INTERFACES §2.2)。

import type { NewSignal } from "./types.js";

export interface DedupRule {
  /** 時刻が無くても、これより近ければ同じ信号とみなす(ミリ秒) */
  windowMs: number;
  /** 端末の送り直しを同じ信号とみなす長さ(ミリ秒) */
  resendWindowMs: number;
}

/** サーバーが使う決まり */
export const DEDUP_RULE: DedupRule = {
  windowMs: 10 * 60 * 1000,
  resendWindowMs: 24 * 60 * 60 * 1000,
};

type Comparable = Pick<NewSignal, "deviceId" | "seq" | "code" | "pos" | "n" | "dir" | "deviceTs" | "receivedAt">;

/** 2 つの signal が同じもの(片方がもう片方の再配信・送り直し)か */
export function isSameSignal(a: Comparable, b: Comparable, rule: DedupRule): boolean {
  if (a.deviceId !== b.deviceId || a.seq !== b.seq) return false;
  const dt = Math.abs(a.receivedAt.getTime() - b.receivedAt.getTime());
  if (dt > rule.resendWindowMs) return false;
  if (a.deviceTs && b.deviceTs) return a.deviceTs.getTime() === b.deviceTs.getTime();
  if (dt <= rule.windowMs) return true;
  return a.code === b.code && a.pos === b.pos && (a.n ?? null) === (b.n ?? null) && (a.dir ?? null) === (b.dir ?? null);
}
