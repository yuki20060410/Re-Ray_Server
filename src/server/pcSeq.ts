// pc(サーバー)の連番(0〜65535。65535 の次は 0。DATAFLOW §8.4)
//
// text と「本部に届いた」が同じ連番を使う(今の仕様)。「本部に届いた」には使わない案が
// GATEWAY_RAW_FORMAT §6 #6 にある。決まったら、ここを分ける。

import type { Storage } from "../storage/types.js";

export class PcSeq {
  private value: number;

  constructor(start = 0) {
    this.value = start & 0xffff;
  }

  /** 再起動したら、最後に送った messages の seq の次から始める */
  static async fromStorage(storage: Storage): Promise<PcSeq> {
    const last = await storage.getLastMessageSeq();
    return new PcSeq(last === null ? 0 : last + 1);
  }

  next(): number {
    const v = this.value;
    this.value = (this.value + 1) & 0xffff;
    return v;
  }
}
