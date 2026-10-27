import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { IDENTITY_TOOL } from "../../shared/tools";
import type { TeraIdentity } from "../data/store";
import { MAX_IDENTITY_CHARS, normalizeIdentity, type IdentityStore } from "../agent/identity";

/**
 * Tera が自分の identity（役割と必要な知識）を読む・書き換えるツール。
 *
 * 書き換えは system プロンプトをすぐには変えない。載るのは前回の圧縮で確定した版
 * （applied）だけで、書いた本文（content）は次に要約が書き換わったときに切り替わる
 * （compaction.ts）。ターンの途中で文脈を組み直さないための規則に揃えている。
 */

export type IdentityToolsOptions = {
  store: IdentityStore;
  /** 読み書きする対象の Tera。 */
  teraId: string;
};

export function createIdentityTools({ store, teraId }: IdentityToolsOptions): ToolSet {
  return {
    [IDENTITY_TOOL]: tool({
      description: [
        "Your identity: the role you take and the knowledge you need for it. It is plain text in your system prompt, and you own it.",
        'action "read" shows the text you wrote and the version your system prompt currently has; action "write" replaces the text you wrote with content.',
        "A write does not change your system prompt now: it replaces the identity there at the next compaction that rewrites the conversation summary, when older messages are summarized. Until then the system prompt keeps the previous version.",
        `Keep it under ${MAX_IDENTITY_CHARS} characters. Write what a future you needs: your role, what you are responsible for, the knowledge the work needs, and how you work. Do not put secrets or tokens in it. An empty content removes your identity.`,
      ].join(" "),
      inputSchema: z.object({
        action: z.enum(["read", "write"]).describe("Operation to perform"),
        content: z
          .string()
          .optional()
          .describe('New identity text for action "write". An empty string removes the identity.'),
      }),
      execute: async ({ action, content }: { action: "read" | "write"; content?: string }) => {
        if (action === "read") return readIdentityText(store.readIdentity(teraId));

        if (content === undefined) {
          throw new Error('action "write" needs content. Pass an empty string to remove your identity.');
        }

        const text = normalizeIdentity(content);
        store.writeIdentity(teraId, text);

        return text.length === 0
          ? "Your identity was cleared. The system prompt keeps the previous version until the next compaction that rewrites the conversation summary; after that the identity section is empty."
          : 'Your identity was updated. The system prompt still has the previous version; this one replaces it at the next compaction that rewrites the conversation summary. Use action "read" to see both.';
      },
    }),
  };
}

/** 書いた版と、system プロンプトに載っている版を返す。 */
function readIdentityText(identity: TeraIdentity): string {
  if (identity.content === "" && identity.applied === "") {
    return 'You have no identity yet. Write one with action "write" when you know the role you take.';
  }

  if (identity.content === identity.applied) {
    return [
      "Your identity (this is the version in your system prompt):",
      "<identity>",
      identity.content,
      "</identity>",
    ].join("\n");
  }

  return [
    "Your identity as you wrote it (it is not in your system prompt yet):",
    "<identity>",
    identity.content === "" ? "(empty)" : identity.content,
    "</identity>",
    "",
    "The version in your system prompt now (from the last compaction that rewrote the summary):",
    "<identity>",
    identity.applied === "" ? "(empty)" : identity.applied,
    "</identity>",
    "",
    "The version you wrote replaces the one in the system prompt at the next compaction that rewrites the summary.",
  ].join("\n");
}
