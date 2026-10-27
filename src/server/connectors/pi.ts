import { posix } from "node:path";
import { oneLine } from "../../shared/text";
import { WORKDIR_IN_CONTAINER } from "../computer/contract";
import { CONNECTOR_PROVIDERS } from "./providers";

/**
 * pi（pi-coding-agent）の設定と確認。
 *
 * pi の LLM 接続設定は、コンピュータの中の `~/.pi/agent/auth.json` と `settings.json` に書く。
 * `pi auth check` は鍵の有無しか見ないので、確認には実際に 1 回呼ぶ。
 * 失敗しても終了コードは 0 のことがあるため、NDJSON の stopReason を読んで判定する。
 *
 * API キーはこのファイルの外へ出さない（ログ・例外文・戻り値に含めない）。
 */

/** コンピュータの中でコマンドを走らせた結果。 */
export type ConnectorScriptResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** コンピュータの中でシェルを走らせる。 */
export type PiRuntime = {
  run(script: string, options: { timeoutMs: number }): Promise<ConnectorScriptResult>;
  /** コンピュータの中のテキストを読む。無ければ null。 */
  readText(path: string): Promise<string | null>;
  /** コンピュータの中へテキストを書く（親フォルダも作る）。 */
  writeText(path: string, text: string): Promise<void>;
};

export type PiStatus = {
  /** 画面に出す 1 行（例: "pi 1.3.0 (anthropic/claude-sonnet-4-5)"）。 */
  status: string;
  /** 設定されている provider id。分からなければ null。 */
  provider: string | null;
  /** 設定されているモデル。分からなければ null。 */
  model: string | null;
};

export type PiSetup = { provider: string; apiKey: string; model: string | null };

/** pi の設定ディレクトリ。 */
const PI_AGENT_DIR = posix.join(WORKDIR_IN_CONTAINER, ".pi", "agent");
const AUTH_PATH = posix.join(PI_AGENT_DIR, "auth.json");
const SETTINGS_PATH = posix.join(PI_AGENT_DIR, "settings.json");

/** 実際に 1 回呼んで確かめるコマンド。 */
const CHECK_COMMAND = "pi -p --mode json --no-session 'Reply with the single word OK.'";

/** 設定ディレクトリとファイルの権限を絞るスクリプト。 */
const CHMOD_COMMAND = `chmod 700 ${shellQuote(PI_AGENT_DIR)} && chmod 600 ${shellQuote(AUTH_PATH)} ${shellQuote(SETTINGS_PATH)}`;

/** モデルの応答を待つ上限。 */
const CHECK_TIMEOUT_MS = 180_000;

/** 版を読む上限。 */
const VERSION_TIMEOUT_MS = 30_000;

/** 書く前の auth.json と settings.json の中身。無ければ null。 */
type PreviousPiFiles = { auth: string | null; settings: string | null };

/** 設定を書いて、実際に 1 回呼んで確かめる。 */
export async function setupPi(runtime: PiRuntime, setup: PiSetup): Promise<PiStatus> {
  const previous: PreviousPiFiles = {
    auth: await runtime.readText(AUTH_PATH),
    settings: await runtime.readText(SETTINGS_PATH),
  };

  const auth = readJsonObject(previous.auth);
  if (auth === null) {
    throw new Error("The pi credentials in the computer could not be read (auth.json).");
  }

  // ほかのプロバイダの項目は残す（別のモデルへ切り替えたときに戻せるようにする）。
  auth[setup.provider] = { type: "api_key", key: setup.apiKey };

  const settings = readJsonObject(previous.settings);
  if (settings === null) {
    throw new Error("The pi settings in the computer could not be read (settings.json).");
  }

  const model = setup.model ?? defaultModelFor(setup.provider);
  if (model === null) {
    throw new Error(`pi has no default model for "${setup.provider}".`);
  }

  // defaultProvider だけでは 403 になる。defaultModel も必ず書く。
  settings["defaultProvider"] = setup.provider;
  settings["defaultModel"] = model;

  await runtime.writeText(AUTH_PATH, `${JSON.stringify(auth, null, 2)}\n`);
  await runtime.writeText(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);

  const chmod = await runtime.run(CHMOD_COMMAND, { timeoutMs: VERSION_TIMEOUT_MS });
  if (chmod.timedOut || chmod.exitCode !== 0) {
    const reason = lastNonEmptyLine(chmod.stderr) ?? lastNonEmptyLine(chmod.stdout);
    throw new Error(reason ?? "The pi settings could not be protected in the computer.");
  }

  try {
    return await checkPi(runtime);
  } catch (error) {
    await restore(runtime, previous);
    throw error;
  }
}

/** 失敗した設定で、動いていた pi を壊さないため、書く前の auth.json と settings.json へ戻す。 */
async function restore(runtime: PiRuntime, previous: PreviousPiFiles): Promise<void> {
  try {
    if (previous.auth === null) {
      await runtime.run(`rm -f ${shellQuote(AUTH_PATH)}`, { timeoutMs: VERSION_TIMEOUT_MS });
    } else {
      await runtime.writeText(AUTH_PATH, previous.auth);
    }

    if (previous.settings === null) {
      await runtime.run(`rm -f ${shellQuote(SETTINGS_PATH)}`, { timeoutMs: VERSION_TIMEOUT_MS });
    } else {
      await runtime.writeText(SETTINGS_PATH, previous.settings);
    }

    await runtime.run(CHMOD_COMMAND, { timeoutMs: VERSION_TIMEOUT_MS });
  } catch {
    // 戻せなくても、元の失敗の理由を差し替えない。
  }
}

/** いまの設定で、実際に 1 回呼んで確かめる。 */
export async function checkPi(runtime: PiRuntime): Promise<PiStatus> {
  const settings = readJsonObject(await runtime.readText(SETTINGS_PATH));
  const provider = stringValue(settings?.["defaultProvider"]);
  const model = stringValue(settings?.["defaultModel"]);

  const versionResult = await runtime.run("pi --version", { timeoutMs: VERSION_TIMEOUT_MS });
  if (versionResult.timedOut) throw new Error("pi did not answer in time.");
  if (versionResult.exitCode !== 0) {
    const reason = lastNonEmptyLine(versionResult.stderr) ?? lastNonEmptyLine(versionResult.stdout);
    throw new Error(reason ?? "pi did not answer.");
  }

  const version = lastNonEmptyLine(versionResult.stdout);
  if (version === null) throw new Error("pi did not answer.");

  const checked = await runtime.run(CHECK_COMMAND, { timeoutMs: CHECK_TIMEOUT_MS });
  if (checked.timedOut) throw new Error("pi did not answer in time.");

  const message = lastMessageWithStopReason(checked.stdout);
  if (message === null) {
    const reason = lastNonEmptyLine(checked.stderr);
    throw new Error(reason ?? "pi did not answer.");
  }

  const stopReason = message["stopReason"];
  if (stopReason === "error") {
    const reason = oneLine(stringValue(message["errorMessage"]) ?? "", 300);
    throw new Error(reason.length > 0 ? reason : "pi could not reach its model.");
  }

  if (stopReason !== "stop" && messageText(message).length === 0) {
    throw new Error("pi did not answer.");
  }

  const status = provider !== null && model !== null ? `pi ${version} (${provider}/${model})` : `pi ${version}`;

  return { status, provider, model };
}

/** JSON のオブジェクトとして読む。無ければ {}、壊れていれば null。 */
function readJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return {};
  if (text.trim().length === 0) return null;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 文字列だけを取り出す。 */
function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** 数字を provider の既定モデルにする。定義に無ければ null。 */
function defaultModelFor(providerId: string): string | null {
  for (const provider of CONNECTOR_PROVIDERS) {
    if (provider.kind !== "program") continue;

    const choice = provider.setup.provider.choices.find((entry) => entry.id === providerId);
    if (choice !== undefined) return choice.defaultModel;
  }
  return null;
}

/** stdout の NDJSON から、message.stopReason を持つ最後の行を返す。 */
function lastMessageWithStopReason(stdout: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;

    const message = (value as Record<string, unknown>)["message"];
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    if (!("stopReason" in message)) continue;

    found = message as Record<string, unknown>;
  }

  return found;
}

/** message.content のテキストをつなぐ。 */
function messageText(message: Record<string, unknown>): string {
  const content = message["content"];
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;

    const entry = part as Record<string, unknown>;
    if (entry["type"] !== "text") continue;

    const text = stringValue(entry["text"]);
    if (text !== null) parts.push(text);
  }

  return parts.join("").trim();
}


/** 出力の最後の空でない行。無ければ null。 */
function lastNonEmptyLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.at(-1) ?? null;
}

/** シェルの 1 引数として安全な形にする。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
