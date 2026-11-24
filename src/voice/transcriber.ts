// 音を文字にする(文字起こし)。差し替えられるように、形を 1 つに決める(2026-11-24 作成)
//
// - OpenAiCompatibleTranscriber: OpenAI と同じ形の API(POST {base}/v1/audio/transcriptions)。
//   自宅サーバーの faster-whisper(speaches。compose.yaml の stt)にも、外のサービス(OpenAI など)にも使える。
//   どこで動かすかは .env の STT_URL・STT_MODEL・STT_API_KEY だけで変わる
// - PlaceholderTranscriber: STT_URL が無いとき。「(音声 3 秒)」のような仮の文を返す(流れを確かめる用)

export interface Transcriber {
  /** 文字にする。声が無ければ空の文字列。失敗したら throw(呼ぶ側がやり直す) */
  transcribe(wav: Buffer, info: { durationMs: number }): Promise<string>;
  /** 画面とログに出す名前 */
  readonly label: string;
}

export interface OpenAiCompatibleOptions {
  /** 例: http://localhost:8000(自宅サーバーの speaches)、https://api.openai.com(外のサービス) */
  baseUrl: string;
  /** 例: Systran/faster-whisper-small(speaches)、whisper-1(OpenAI) */
  model: string;
  /** 外のサービスのときだけ */
  apiKey?: string;
  language?: string;
  /** 1 回の上限(CPU だけの faster-whisper は 15 秒の音に数十秒かかることがある) */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class OpenAiCompatibleTranscriber implements Transcriber {
  readonly label: string;
  private readonly fetchFn: typeof fetch;
  private triedDownload = false;

  constructor(private readonly o: OpenAiCompatibleOptions) {
    this.label = `${o.model}(${new URL(o.baseUrl).host})`;
    this.fetchFn = o.fetchFn ?? fetch;
  }

  async transcribe(wav: Buffer): Promise<string> {
    const res = await this.post(wav);
    // speaches は、まだ取ってきていないモデルを 404 で断る。1 回だけ取ってこさせて、やり直す
    if (res.status === 404 && !this.triedDownload) {
      this.triedDownload = true;
      await this.downloadModel();
      return this.read(await this.post(wav));
    }
    return this.read(res);
  }

  private async post(wav: Buffer): Promise<Response> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
    form.append("model", this.o.model);
    form.append("language", this.o.language ?? "ja");
    form.append("response_format", "json");
    return this.fetchFn(new URL("/v1/audio/transcriptions", this.o.baseUrl), {
      method: "POST",
      body: form,
      headers: this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {},
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
    });
  }

  private async read(res: Response): Promise<string> {
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`文字起こしのエラー ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as { text?: unknown };
    if (typeof body.text !== "string") throw new Error("文字起こしの返事に text が無い");
    return body.text.trim();
  }

  /** speaches のモデルの取得(POST /v1/models/{id})。外のサービスでは使わない(失敗しても構わない) */
  private async downloadModel(): Promise<void> {
    const res = await this.fetchFn(new URL(`/v1/models/${this.o.model}`, this.o.baseUrl), {
      method: "POST",
      headers: this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {},
      signal: AbortSignal.timeout(30 * 60_000), // はじめては数百 MB を取ってくる
    }).catch(() => null);
    if (res && !res.ok) {
      throw new Error(`文字起こしのモデル ${this.o.model} を用意できない(${res.status})`);
    }
  }
}

/** STT_URL が無いときの仮の文字起こし(音は聞かない) */
export class PlaceholderTranscriber implements Transcriber {
  readonly label = "仮(STT_URL が無い)";
  async transcribe(_wav: Buffer, info: { durationMs: number }): Promise<string> {
    return `(音声 ${Math.max(1, Math.round(info.durationMs / 1000))} 秒。文字起こしは未設定)`;
  }
}
