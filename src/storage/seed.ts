// 一覧表の最初の中身(仮。チーム未合意。SIGNAL_FORMAT §4 の叩き台、共通仕様 01 の段階0の宿題)
//
// MySQL では db/init/02_seed.sql が同じものを入れる。**中身を変えるときは両方を直す。**
// メモリ版は、これを持った状態で始まる(管理画面がすぐ使えるように)。
// 2026-11-06: reray-app の server/sql/02_seed.sql から写した

import type { InstructionCode, PositionInput, SignalCode } from "./types.js";

export const SEED_POSITIONS: readonly PositionInput[] = [
  { no: 1, name: "本部テント", place: "市役所前広場", lat: 35.6812, lon: 139.7671 },
  { no: 2, name: "北口", place: "駅の北口ロータリー", lat: 35.6823, lon: 139.7668 },
  { no: 3, name: "体育館前", place: "避難所", lat: 35.6799, lon: 139.7685 },
  { no: 4, name: "南橋", place: "川の見回り地点", lat: 35.6787, lon: 139.7662 },
];

function sig(
  code: number,
  name: string,
  shortName: string,
  glassText: string,
  over: Partial<SignalCode> = {},
): SignalCode {
  return {
    code,
    name,
    shortName,
    glassText,
    positionRule: "optional",
    quantityRule: "none",
    quantityUnit: null,
    hasDirection: false,
    priority: "normal",
    isSos: false,
    ...over,
  };
}

export const SEED_SIGNAL_CODES: readonly SignalCode[] = [
  sig(1, "SOS", "SOS", "送信:SOS", { priority: "highest", isSos: true }),
  sig(2, "無事", "無事", "送信:無事"),
  sig(3, "了解", "了解", "送信:了解", { positionRule: "none" }),
  sig(4, "到着", "到着", "送信:到着"),
  sig(5, "応援を頼む", "応援", "送信:応援 {数}人", { quantityRule: "required", quantityUnit: "人", priority: "high" }),
  sig(6, "要救助者あり", "要救助", "送信:要救助者あり {数}人", { quantityRule: "required", quantityUnit: "人", priority: "high" }),
  sig(7, "負傷者あり", "負傷", "送信:負傷者あり {数}人", { quantityRule: "required", quantityUnit: "人", priority: "high" }),
  sig(8, "食料がほしい", "食料", "送信:食料 {数}食", { quantityRule: "required", quantityUnit: "食" }),
  sig(9, "移動します", "移動", "送信:移動します {方角}", { hasDirection: true }),
];

function ins(code: number, name: string, withPos: string | null, withoutPos: string | null): InstructionCode {
  return {
    code,
    name,
    usesPosition: withPos !== null,
    textWithPos: withPos,
    textWithoutPos: withoutPos,
    requiresResponse: true,
    strength: null,
  };
}

export const SEED_INSTRUCTION_CODES: readonly InstructionCode[] = [
  ins(1, "移動", "{ポジション名}へ移動してください", null),
  ins(2, "集合", "{ポジション名}に集合してください", null),
  ins(3, "待機", null, "その場で待機してください"),
  ins(6, "退避", "{ポジション名}へ退避してください", null),
  ins(20, "応援", "{ポジション名}の応援に向かってください", null),
  ins(40, "状況報告", null, "いまの状況を報告してください"),
];
