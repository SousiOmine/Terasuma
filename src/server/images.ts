import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageRef } from "../shared/types";

/**
 * ツールが撮った画像を、データディレクトリにファイルとして置く。
 *
 * 会話には参照（ハッシュ・種類・大きさ）だけを残し、実体はここに置く。
 * 同じ中身なら同じファイルを使い回すので、同じ画面を何度撮っても増えない。
 * 画面へは /api/images/<sha256> で返す。
 */

/** 扱う画像の種類。ここに無い種類は保存しない（拡張子と配信の種類が決まらないため）。 */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** 中身がハッシュで決まるので、URL ごと長く持たせてよい。 */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/** ファイル名に使えるハッシュの形。パスを組み立てる前に必ずこれで確かめる。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** ディレクトリ名。データディレクトリの直下に置く。 */
const IMAGES_DIR_NAME = "images";

export type FoundImage = {
  data: Uint8Array;
  mime: string;
};

export type ImageStore = {
  /** 画像を保存して参照を返す。同じ中身なら同じ参照になる。 */
  save(data: Uint8Array, mime: string): ImageRef;
  /** 参照から実体を読む。ファイルが無ければ null。 */
  read(ref: ImageRef): Uint8Array | null;
  /** 配信のために、ハッシュから実体を探す。 */
  find(sha256: string): FoundImage | null;
  /** 配信のときに付けるヘッダ。 */
  cacheControl: string;
};

export function createImageStore(dataDir: string): ImageStore {
  const imagesDir = join(dataDir, IMAGES_DIR_NAME);

  function fileFor(sha256: string, extension: string): string {
    return join(imagesDir, `${sha256}.${extension}`);
  }

  return {
    cacheControl: CACHE_CONTROL,

    save(data, mime) {
      const extension = MIME_EXTENSIONS[mime];
      if (extension === undefined) {
        throw new Error(`扱えない画像の種類です: ${mime}（使える種類: ${Object.keys(MIME_EXTENSIONS).join(", ")}）`);
      }

      const size = readImageSize(data, mime);
      const sha256 = createHash("sha256").update(data).digest("hex");
      const file = fileFor(sha256, extension);

      if (!existsSync(file)) {
        mkdirSync(imagesDir, { recursive: true });
        writeFileSync(file, data);
      }

      return { sha256, mime, width: size.width, height: size.height };
    },

    read(ref) {
      const extension = MIME_EXTENSIONS[ref.mime];
      if (extension === undefined) return null;
      // 参照は保存済みの値だが、パスを組み立てる前に形を確かめる。
      // MCP サーバーのツール結果から作られた参照は、端末の外で決まった値でもある。
      if (!SHA256_PATTERN.test(ref.sha256)) return null;

      const file = fileFor(ref.sha256, extension);
      return existsSync(file) ? readFileSync(file) : null;
    },

    find(sha256) {
      // ハッシュ以外を受け付けない（パスを組み立てる材料にするため）。
      if (!SHA256_PATTERN.test(sha256)) return null;

      for (const [mime, extension] of Object.entries(MIME_EXTENSIONS)) {
        const file = fileFor(sha256, extension);
        if (existsSync(file)) return { data: readFileSync(file), mime };
      }
      return null;
    },
  };
}

/**
 * 画像の大きさを読む。
 * 撮影は PNG で行うので、読めない中身は壊れているとして失敗させる
 * （大きさが分からないまま参照を保存すると、あとから座標の対応が取れなくなる）。
 */
function readImageSize(data: Uint8Array, mime: string): { width: number; height: number } {
  if (mime !== "image/png") {
    throw new Error(`${mime} の大きさを読む方法がありません（いまは image/png だけを扱えます）`);
  }
  if (data.length < 24) throw new Error("PNG として短すぎます");

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // 署名と、先頭のチャンクが IHDR であることを確かめてから大きさを読む。
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) {
    throw new Error("PNG の署名がありません");
  }
  if (view.getUint32(12) !== 0x49484452) {
    throw new Error("PNG の先頭に IHDR がありません");
  }

  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) {
    throw new Error(`画像の大きさを読めませんでした（${width}x${height}）`);
  }
  return { width, height };
}
