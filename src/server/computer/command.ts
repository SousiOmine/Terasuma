import { describeError } from "../../shared/errors";

/**
 * この端末でコマンドを 1 つ実行する。
 *
 * コンテナ（podman）と、エージェントの bash ツールが同じ処理を使う。
 * 出力の上限・待ち時間の上限・中断の扱いを 2 か所に分けないため、ここに 1 つだけ置く。
 */

/** コマンド 1 回分の結果。 */
export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** 出力の上限を超えて切られたかどうか。 */
  truncated: boolean;
  /** 待ち時間の上限で打ち切ったかどうか。 */
  timedOut: boolean;
};

/**
 * コマンドの実行。テストでは podman などの呼び出しを、この型を満たす別の関数に
 * 差し替えて確かめる。実行ファイルが見つからない場合も例外にせず、code -1 の
 * 結果として返す。signal が立つと、実行中のコマンドを打ち切る。
 */
export type CommandRunner = (cmd: readonly string[], options: RunCommandOptions) => Promise<CommandResult>;

/** バイト列を返す実行の結果。画面の撮影のように、文字列へ直せない出力に使う。 */
export type CommandBytesResult = {
  code: number;
  stdout: Uint8Array;
  stderr: string;
  timedOut: boolean;
  /** 出力の上限を超えて切られたかどうか。 */
  truncated: boolean;
};

/**
 * バイト列を返す実行。テストでは podman などの呼び出しを、この型を満たす別の関数に
 * 差し替えて確かめる。文字列の結果では中身が壊れるもの（PNG など）だけがこちらを使う。
 */
export type CommandByteRunner = (cmd: readonly string[], options: RunCommandOptions) => Promise<CommandBytesResult>;

export type RunCommandOptions = {
  /** 残すバイト数の上限。バイト列を返す実行だけが使う。省くと 32MB。 */
  maxOutputBytes?: number;
  timeoutMs: number;
  /** 実行するディレクトリ。省くとこのプロセスの作業ディレクトリ。 */
  cwd?: string;
  /** ターンの停止などで打ち切るための signal。 */
  signal?: AbortSignal;
  /** 標準入力へ流す内容。省くと標準入力を開かない。 */
  stdin?: string | Uint8Array;
  /**
   * 残す出力の上限（文字数）。省くと 20,000 文字。
   * bash のように末尾を読みたい呼び出しは、大きめの値を渡してから自分で詰める。
   */
  maxOutputChars?: number;
  /** 上限を超えたときに、先頭を残すか末尾を残すか。省くと先頭。 */
  outputFrom?: "head" | "tail";
};

/**
 * 1 回の呼び出しで受け取る出力の上限（文字数）。超えた分は捨てて、切ったことを結果に書く。
 * 上限を決めずに読むと、暴走したコマンドの出力でこちらのメモリが埋まる。
 */
const OUTPUT_LIMIT = 20_000;

/** バイト列で受け取る出力の上限。画面の PNG には十分で、暴走した出力でメモリを埋めない大きさ。 */
const OUTPUT_BYTE_LIMIT = 32 * 1024 * 1024;

export async function runCommand(cmd: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const abort = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

  try {
    const proc = Bun.spawn({
      cmd: [...cmd],
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: abort,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    // 標準入力への書き込みは、出力の読み取りと同時に進める。
    // 先に全部書いてから読むと、双方のパイプが詰まって止まる。
    const writeInput = (async (): Promise<void> => {
      if (options.stdin === undefined) return;

      const stdin = proc.stdin;
      if (stdin === undefined) throw new Error("standard input is not available");

      try {
        await stdin.write(options.stdin);
        await stdin.end();
      } catch {
        // コマンドが入力を読む前に終わった場合。理由は終了コードと stderr に残る。
      }
    })();

    const limit = options.maxOutputChars ?? OUTPUT_LIMIT;
    const from = options.outputFrom ?? "head";
    const [stdout, stderr] = await Promise.all([
      readLimited(proc.stdout, limit, from),
      readLimited(proc.stderr, limit, from),
    ]);
    await writeInput;
    const code = await proc.exited;

    return {
      code,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timedOut: timeout.aborted,
    };
  } catch (error) {
    // 実行ファイルが無い場合と、signal で打ち切られた場合にここへ来る。
    // どちらも結果として返し、呼び出し側が理由をモデルへ見せられるようにする。
    return { code: -1, stdout: "", stderr: describeError(error), truncated: false, timedOut: timeout.aborted };
  }
}

/** 出力をバイト列のまま受け取る。上限を超えた分は読み捨て、切ったことを結果に書く。 */
export async function runCommandBytes(cmd: readonly string[], options: RunCommandOptions): Promise<CommandBytesResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const abort = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

  try {
    const proc = Bun.spawn({
      cmd: [...cmd],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: abort,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    const [stdout, stderr, code] = await Promise.all([
      readBytesLimited(proc.stdout, options.maxOutputBytes ?? OUTPUT_BYTE_LIMIT),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      code,
      stdout: stdout.bytes,
      stderr: stderr.slice(0, OUTPUT_LIMIT),
      timedOut: timeout.aborted,
      truncated: stdout.truncated,
    };
  } catch (error) {
    return {
      code: -1,
      stdout: new Uint8Array(),
      stderr: describeError(error),
      timedOut: timeout.aborted,
      truncated: false,
    };
  }
}

/**
 * バイト列を上限まで読み、超えた分は捨てる。
 * 超えたあともストリームは読み切る（子プロセスが詰まらないように）。
 */
async function readBytesLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;

    const value = chunk.value;
    if (total + value.byteLength > limit) {
      const keep = limit - total;
      if (keep > 0) chunks.push(value.subarray(0, keep));
      total = limit;
      truncated = true;
      continue;
    }

    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

/**
 * ストリームを上限まで読み、超えた分は捨てる。
 * 先頭を残す場合は、上限に達したあともストリームを読み切る（子プロセスが詰まらないように）。
 * 末尾を残す場合は、常に最後の limit 文字だけを抱える。
 */
async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  from: "head" | "tail",
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let text = "";
  let truncated = false;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (from === "head" && truncated) continue;

    const piece = decoder.decode(chunk.value, { stream: true });
    text += piece;

    if (text.length > limit) {
      truncated = true;
      text = from === "head" ? text.slice(0, limit) : tailOf(text, limit);
    }
  }

  text += decoder.decode();
  if (text.length > limit) {
    truncated = true;
    text = from === "head" ? text.slice(0, limit) : tailOf(text, limit);
  }

  return { text, truncated };
}

/** 末尾 limit 文字を取る。先頭がサロゲートペアの後半なら、そこは落とす。 */
function tailOf(text: string, limit: number): string {
  const tail = text.slice(text.length - limit);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}
