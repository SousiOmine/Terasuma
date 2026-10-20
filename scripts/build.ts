import { rm } from "node:fs/promises";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

/**
 * 本番ビルド。
 *
 * `bun build` の CLI は bunfig.toml の [serve.static] plugins を適用しないため、
 * Tailwind のプラグインをここで明示的に渡している（CSS が未処理のまま出力されてしまう）。
 * 開発サーバ（Bun.serve）側は bunfig.toml を読むので、そちらではプラグインが適用される。
 */
const projectRoot = join(import.meta.dir, "..");
const srcDir = join(projectRoot, "src");
const outdir = join(projectRoot, "dist");

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(srcDir, "index.ts")],
  // root を src にすると dist/index.js と dist/client/... の分かりやすい配置になる。
  root: srcDir,
  outdir,
  target: "bun",
  minify: true,
  // 本番の判定は起動時の環境変数ではなく、ビルドに埋め込む。
  // こうすると起動側で NODE_ENV=... を前置する必要がない（Windows でも同じ手順になる）。
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [tailwind],
});

for (const log of result.logs) {
  console.error(log.level === "error" ? `[error] ${log.message}` : `[${log.level}] ${log.message}`);
}

if (!result.success) {
  console.error("ビルドに失敗しました");
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(`${output.path}  ${output.size} bytes`);
}
