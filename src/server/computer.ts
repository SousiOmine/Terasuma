import { createTool } from "@mastra/core/tools";
import type { Tool } from "@mastra/core/tools";
import { z } from "zod";
import type { ImageRef } from "../shared/types";
import type { ContainerManager, ShellResult } from "./container";
import type { ComputerToolsetProvider } from "./engine";
import type { Handover } from "./handover";
import type { ImageStore } from "./images";

/**
 * コンテナの画面とシェルをエージェントに渡すツールセット。
 *
 * Terasuma 自身の機能なので、MCP サーバーのようにユーザーが足したり消したりする対象ではない。
 * エンジンの中に内蔵のツールセットとして持つ。
 *
 * ツール名は "<ツールセット名>_<ツール名>" の規則に乗せて、"computer_" で始める。
 * MCP のツール（"<サーバー id>_<ツール名>"）と同じ名前空間に並ぶので、
 * 衝突する名前が無いかを config.ts の mcpServerIdProblem で弾いている。
 *
 * 説明文には可変の情報を入れない。説明文はリクエストの前置きに入るので、
 * 変えるとプロンプトキャッシュが当たらなくなる。
 *
 * 座標は画面の絶対座標（原点は左上）。画面の大きさは 1280x800 で動かさないので、
 * 撮った画像で読んだ座標をそのままクリックに渡せる。
 */

/** モデルへ渡すツール。キーはツール名（"computer_shell" など）。 */
export type ComputerToolset = Record<string, Tool<any, any, any, any>>;

/** 操作 1 つの待ち時間。応答が返ってこない操作でターンが終わらなくなるのを防ぐ。 */
const ACTION_TIMEOUT_MS = 15_000;

/** computer_shell の待ち時間の上限。 */
export const SHELL_TIMEOUT_MS = 120_000;

/**
 * ツールの実行に渡ってくる中断。
 * ターンが止まったら、待っている操作もコンテナのコマンドも打ち切る。
 */
type ToolContext = { abortSignal?: AbortSignal };

/**
 * モデルへ渡すコンテナのツールを決める。
 *
 * podman が無い端末では 1 つも渡さない。呼ばせてから失敗させると、
 * ターンを 1 つ無駄に使ったうえで、モデルは「起動してください」としか言えない。
 * コンテナが止まっているだけの場合は渡す（自分で起動できないので、理由を伝えられるようにする）。
 */
export function createComputerToolset(options: ComputerToolsetOptions): ComputerToolsetProvider {
  return {
    async toolset(input) {
      const status = await options.container.status();
      if (status.state === "podman_missing") return {};
      return createComputerTools({ ...options, teraId: input.teraId, onImage: input.onImage });
    },
  };
}

/** ツールセットの供給元が受け取る材料。 */
export type ComputerToolsetOptions = {
  container: ContainerManager;
  images: ImageStore;
  /** ユーザーへ画面を渡す待ち。 */
  handover: Handover;
};

export type ComputerToolsOptions = ComputerToolsetOptions & {
  /** ターンの対象の Tera。 */
  teraId: string;
  /**
   * 撮った画像を、このターンの次のステップでモデルへ渡すために知らせる。
   * tool の本文に画像を置けるプロバイダが無いので、渡す口はここで作る。
   */
  onImage?: (image: ImageRef) => void;
};

export function createComputerTools(options: ComputerToolsOptions): ComputerToolset {
  const { container, images, handover, teraId, onImage } = options;

  /** xdotool を 1 回呼ぶ。失敗と打ち切りは例外にして、モデルが理由を読めるようにする。 */
  async function xdotool(args: readonly string[], signal?: AbortSignal): Promise<ShellResult> {
    const result = await container.exec(["xdotool", ...args], { timeoutMs: ACTION_TIMEOUT_MS, signal });
    if (result.timedOut) {
      throw new Error(`xdotool ${args[0] ?? ""} が ${ACTION_TIMEOUT_MS / 1000} 秒で終わりませんでした`);
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `xdotool が終了コード ${result.exitCode} で失敗しました`);
    }
    return result;
  }

  return {
    computer_screenshot: createTool({
      id: "computer_screenshot",
      description: [
        "Take a screenshot of the computer desktop and return it as an image.",
        "The screen size is fixed, so coordinates read from the image can be used as they are.",
        "The mouse pointer is not drawn in the image.",
      ].join(" "),
      inputSchema: z.object({}),
      execute: async () => {
        const png = await container.screenshot();
        const image = images.save(png, "image/png");
        onImage?.(image);
        return { text: `The screen is ${image.width}x${image.height} pixels.`, image };
      },
      // 画像はここには入れない。tool の本文に画像を置けるプロバイダが無いため、
      // 保存した参照から組み立てる側（prompt.ts）が user メッセージとして渡す。
      // outputSchema を指定しないため戻り値は unknown になる。形は execute が決めている。
      toModelOutput: (output: unknown) => ({ type: "text", value: (output as ImageOutput).text }),
    }),

    computer_click: createTool({
      id: "computer_click",
      description: [
        "Click at the given screen coordinates.",
        "The origin (0,0) is the top-left corner of the screenshot.",
      ].join(" "),
      inputSchema: z.object({
        x: z.number().int().min(0).describe("X coordinate in pixels"),
        y: z.number().int().min(0).describe("Y coordinate in pixels"),
        button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button to use (default: left)"),
        count: z.number().int().min(1).max(3).optional().describe("How many times to click (default: 1)"),
      }),
      execute: async (
        { x, y, button, count }: { x: number; y: number; button?: string; count?: number },
        context: ToolContext,
      ) => {
        const times = count ?? 1;
        await xdotool(["mousemove", String(x), String(y)], context.abortSignal);
        await xdotool(["click", "--repeat", String(times), String(BUTTON_CODES[button ?? "left"])], context.abortSignal);
        return `clicked ${button ?? "left"} ${times} time(s) at ${x},${y}`;
      },
    }),

    computer_scroll: createTool({
      id: "computer_scroll",
      description: "Scroll the mouse wheel at the given screen coordinates.",
      inputSchema: z.object({
        x: z.number().int().min(0).describe("X coordinate in pixels"),
        y: z.number().int().min(0).describe("Y coordinate in pixels"),
        direction: z.enum(["up", "down", "left", "right"]).describe("Direction to scroll"),
        amount: z.number().int().min(1).max(20).optional().describe("Number of wheel steps (default: 3)"),
      }),
      execute: async (
        {
          x,
          y,
          direction,
          amount,
        }: {
          x: number;
          y: number;
          direction: string;
          amount?: number;
        },
        context: ToolContext,
      ) => {
        const steps = amount ?? 3;
        await xdotool(["mousemove", String(x), String(y)], context.abortSignal);
        await xdotool(["click", "--repeat", String(steps), String(SCROLL_BUTTONS[direction])], context.abortSignal);
        return `scrolled ${direction} ${steps} step(s) at ${x},${y}`;
      },
    }),

    computer_type: createTool({
      id: "computer_type",
      description: [
        "Type text with the keyboard into the focused window.",
        "Click the target first to focus it.",
      ].join(" "),
      inputSchema: z.object({
        text: z.string().describe("Text to type"),
      }),
      execute: async ({ text }: { text: string }, context: ToolContext) => {
        await xdotool(["type", "--delay", "20", "--", text], context.abortSignal);
        return `typed ${text.length} character(s)`;
      },
    }),

    computer_key: createTool({
      id: "computer_key",
      description: [
        "Press a key or a key combination, such as \"Return\", \"Escape\", \"ctrl+c\" or \"alt+Tab\".",
        "The names are the ones xdotool accepts.",
      ].join(" "),
      inputSchema: z.object({
        key: z.string().describe("Key name or combination"),
      }),
      execute: async ({ key }: { key: string }, context: ToolContext) => {
        await xdotool(["key", "--", key], context.abortSignal);
        return `pressed ${key}`;
      },
    }),

    computer_windows: createTool({
      id: "computer_windows",
      description: [
        "List the visible windows on the desktop, with the one that has the keyboard focus.",
        "Use this to find out what is open before clicking or typing.",
      ].join(" "),
      inputSchema: z.object({}),
      execute: async (_input: Record<string, never>, context: ToolContext) => {
        const result = await container.shell(WINDOW_LIST_SCRIPT, {
          timeoutMs: ACTION_TIMEOUT_MS,
          signal: context.abortSignal,
        });
        return formatWindows(result);
      },
    }),

    computer_wait: createTool({
      id: "computer_wait",
      description: "Wait for the given number of seconds (for example, while an application starts up).",
      inputSchema: z.object({
        seconds: z.number().min(0).max(60).describe("Seconds to wait"),
      }),
      execute: async ({ seconds }: { seconds: number }, context: ToolContext) => {
        await waitFor(seconds * 1_000, context.abortSignal);
        return `waited ${seconds} second(s)`;
      },
    }),

    computer_open: createTool({
      id: "computer_open",
      description: [
        "Start an application on the computer desktop.",
        "The application keeps running after the call returns; take a screenshot to see it.",
      ].join(" "),
      inputSchema: z.object({
        command: z.string().describe('Command to start, for example "xterm"'),
        args: z.array(z.string()).optional().describe("Arguments for the command"),
      }),
      execute: async ({ command, args }: { command: string; args?: string[] }, context: ToolContext) => {
        // exec の呼び出しが終わっても残るよう、nohup で切り離して起動する。
        const line = `nohup ${[command, ...(args ?? [])].map(quote).join(" ")} >/dev/null 2>&1 &`;
        const result = await container.shell(line, { timeoutMs: ACTION_TIMEOUT_MS, signal: context.abortSignal });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `起動できませんでした（終了コード ${result.exitCode}）`);
        }
        return `started ${command}`;
      },
    }),

    computer_ask_user: createTool({
      id: "computer_ask_user",
      description: [
        "Hand the computer screen over to the user and wait for them.",
        "Use this for logins, two-factor codes, identity checks, or any choice only the user can make.",
        "What the user replies, or that the user finished, comes back as the result.",
        "Do not take screenshots while the user is working on the screen.",
      ].join(" "),
      inputSchema: z.object({
        question: z.string().min(1).describe("What you need the user to do, written for the user to read"),
      }),
      execute: async (_input: { question: string }, context: ToolContext) => {
        const signal = context.abortSignal;
        // 中断を受け取れないと、ユーザーを待ったままターンを片付けられなくなる。
        if (signal === undefined) throw new Error("ターンの中断を受け取れないため、ユーザーを待てません");

        // 何を頼むかは、呼び出しの引数としてそのまま画面へ流れる。
        return handover.wait(teraId, signal);
      },
    }),

    computer_shell: createTool({
      id: "computer_shell",
      description: [
        "Run a shell command on the Debian computer that you operate.",
        "The command runs as bash -lc in /home/agent (the folder shared with the user's machine).",
        "sudo works without a password.",
        "Returns the exit code, standard output, and standard error.",
      ].join(" "),
      inputSchema: z.object({
        command: z.string().describe('Shell command to run, for example "uname -a"'),
      }),
      execute: async ({ command }: { command: string }, context: ToolContext) => {
        const result = await container.shell(command, { timeoutMs: SHELL_TIMEOUT_MS, signal: context.abortSignal });
        return formatShellResult(result);
      },
    }),
  };
}

/** xdotool に渡すボタンの番号。 */
const BUTTON_CODES: Record<string, number> = { left: 1, middle: 2, right: 3 };

/** ホイールの番号。xdotool の慣例で 4/5 が縦、6/7 が横。 */
const SCROLL_BUTTONS: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 };

/** 見えているウィンドウと、キーボードの入力先を出す。 */
const WINDOW_LIST_SCRIPT = [
  'for id in $(xdotool search --onlyvisible --name "." 2>/dev/null); do',
  '  name=$(xdotool getwindowname "$id" 2>/dev/null) || continue',
  '  [ -n "$name" ] || continue',
  '  geometry=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null | tr "\\n" " ")',
  '  if [ "$id" = "$(xdotool getactivewindow 2>/dev/null)" ]; then',
  '    echo "active|$id|$name|$geometry"',
  "  else",
  '    echo "window|$id|$name|$geometry"',
  "  fi",
  "done",
].join("\n");

/** シェルへ渡す 1 つの引数を引用する（空白や記号をそのまま渡せるようにする）。 */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** ウィンドウ一覧の生の出力を、モデルが読みやすい形にする。 */
function formatWindows(result: ShellResult): string {
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `ウィンドウ一覧を取れませんでした（終了コード ${result.exitCode}）`);
  }

  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return "no visible windows";

  return lines
    .map((line) => {
      const [kind, id, name, geometry] = line.split("|");
      const position = /X=(-?\d+) Y=(-?\d+) WIDTH=(\d+) HEIGHT=(\d+)/.exec(geometry ?? "");
      const bounds =
        position === null
          ? ""
          : ` at ${position[1]},${position[2]} size ${position[3]}x${position[4]}`;
      return `${kind === "active" ? "* " : "  "}${id ?? "?"} ${name ?? ""}${bounds}`;
    })
    .join("\n");
}

/** シェルの結果を、モデルと画面に見せる 1 つの文字列にする。 */
function formatShellResult(result: ShellResult): string {
  const sections: string[] = [`exit code: ${result.exitCode}`];

  if (result.stdout.length > 0) sections.push(`--- stdout ---\n${trimTrailingNewline(result.stdout)}`);
  if (result.stderr.length > 0) sections.push(`--- stderr ---\n${trimTrailingNewline(result.stderr)}`);

  // 切ったことと打ち切ったことは黙らない（結果が途中であることをモデルが説明できるように）。
  if (result.truncated) sections.push("(output was too long and has been cut off)");
  if (result.timedOut) sections.push(`(stopped after ${SHELL_TIMEOUT_MS / 1000} seconds)`);

  return sections.join("\n");
}

/** 画像つきのツールの戻り値。 */
type ImageOutput = { text: string; image: ImageRef };

/**
 * 指定した時間だけ待つ。ターンが止まったら、待つのもやめる。
 * 止められないと、停止したあともタイマーが残り、その間ターンが片付かない。
 */
function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("ターンが終了したため、待つのをやめました"));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    if (signal?.aborted === true) {
      clearTimeout(timer);
      reject(new Error("ターンはすでに終了しています"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function trimTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
