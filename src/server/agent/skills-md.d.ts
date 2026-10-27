/**
 * スキルの本文（Markdown）を、文字列として読み込む宣言。
 *
 * Bun は `import text from "./x.md" with { type: "text" }` を文字列として束ねる。
 * TypeScript はその形を知らないので、ここで型だけを与える（bundle の挙動は Bun が決める）。
 */
declare module "*.md" {
  const content: string;
  export default content;
}
