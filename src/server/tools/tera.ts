import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { isTeraId } from "../../shared/ids";
import { TERA_CREATE_TOOL_NAME } from "../../shared/tools";
import type { TeraDirectory } from "../data/store";
import { ensureTeraWorkspace } from "../computer/workspaces";
import type { TeraToolsetProvider } from "../agent/contracts";
import { composeTeraIdentity, MAX_IDENTITY_CHARS } from "../agent/identity";

/**
 * 新しい Tera を作るツール。
 *
 * Tera は会話・identity・作業フォルダを 1 つずつ持つ。新しい Tera を作ると、
 * 別の役割に自分の履歴と作業場を与えられる（この会話には混ざらない）。
 *
 * 何を作るかはユーザーが決めるので、ツールは質問しない。ユーザーの答えを
 * 受け取ってから呼ぶのはモデルの仕事で、手順は組み込みスキル tera-create にある。
 * ツール一覧には載せず、tool_search で見つけて tool_call で実行する。
 */

/** 画面の一覧に出す名前の上限（文字数）。 */
const MAX_TERA_NAME_CHARS = 60;

/** id の上限（文字数）。作業フォルダの名前になるので、長すぎるものは受け付けない。 */
const MAX_TERA_ID_CHARS = 64;

/** モデルへ渡すツール。キーは "tera_create"。 */
export type TeraToolset = ToolSet;

export type TeraToolsetOptions = {
  /** Tera の一覧と作成。 */
  store: TeraDirectory;
  /** 作業フォルダを作るデータディレクトリ（コンテナのホームを含む場所）。 */
  dataDir: string;
};

/** ツール一式の供給元。作る先はアプリが決めるので、ツールの組み立てはここで閉じる。 */
export function createTeraToolset(options: TeraToolsetOptions): TeraToolsetProvider {
  return { toolset: () => createTeraTools(options) };
}

/** tera_create の引数。 */
type CreateInput = {
  id: string;
  name: string;
  role: string;
  policy: string;
};

function createTeraTools({ store, dataDir }: TeraToolsetOptions): TeraToolset {
  return {
    [TERA_CREATE_TOOL_NAME]: tool({
      description: [
        "Create another Tera: a separate assistant with its own name, role, behavior policy and conversation history.",
        "The new Tera starts with an identity built from name, role and policy, so that role is in its system prompt from its first turn, and it gets its own workspace folder.",
        'id becomes the workspace folder name: lowercase letters, digits and hyphens, starting with a letter or digit, for example "researcher".',
        "A name or id that is already used fails and creates nothing.",
        "Only call this after the user has answered with the name, role and policy they want: this tool does not ask them.",
      ].join(" "),
      inputSchema: z.object({
        id: z
          .string()
          .min(1)
          .max(MAX_TERA_ID_CHARS)
          .describe(
            'Workspace folder name: lowercase letters, digits and hyphens, starting with a letter or digit (for example "researcher")',
          ),
        name: z
          .string()
          .min(1)
          .max(MAX_TERA_NAME_CHARS)
          .describe(`Name shown in the sidebar (1-${MAX_TERA_NAME_CHARS} characters), in the user's words`),
        role: z
          .string()
          .min(1)
          .max(MAX_IDENTITY_CHARS)
          .describe("What the Tera is responsible for, in the user's words"),
        policy: z
          .string()
          .min(1)
          .max(MAX_IDENTITY_CHARS)
          .describe("How it should work: tone, what it checks, when it asks the user, in the user's words"),
      }),
      execute: async ({ id, name, role, policy }: CreateInput) => {
        if (!isTeraId(id)) {
          throw new Error(
            `The id ${JSON.stringify(id)} cannot be used as a workspace folder name. ` +
              'Use lowercase letters, digits and hyphens, starting with a letter or digit, for example "researcher".',
          );
        }

        const displayName = name.trim();
        if (displayName.length === 0) throw new Error("The name must not be empty.");

        const sameId = store.getTera(id);
        if (sameId !== null) {
          throw new Error(`A Tera with id ${JSON.stringify(id)} already exists (${sameId.name}). Choose another id.`);
        }

        const sameName = store.findTeraByName(displayName);
        if (sameName !== null) {
          throw new Error(
            `A Tera named ${JSON.stringify(displayName)} already exists (id ${JSON.stringify(sameName.id)}). Choose another name.`,
          );
        }

        const identity = composeTeraIdentity({ name: displayName, role: role.trim(), policy: policy.trim() });

        // 作業フォルダを先に作る。ここで失敗すれば、Tera の行も何も残らない。
        const workspace = ensureTeraWorkspace(dataDir, id);
        const tera = store.createTera({ id, name: displayName, identity });

        return [
          `Created the Tera ${JSON.stringify(tera.name)} (id ${JSON.stringify(tera.id)}).`,
          "Its identity holds the role and policy you passed, so it works that way from its first turn.",
          `Its workspace is ${workspace}.`,
          "It appears in the sidebar; the user opens it there. This conversation does not switch to it.",
        ].join(" ");
      },
    }),
  };
}
