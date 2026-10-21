import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageRef } from "../../shared/types";

/**
 * ツールが返した画像を、データディレクトリにファイルとして置く。
 *
 * 会話には参照（ハッシュ・種類・大きさ）だけを残し、実体はここに置く。
 * 同じ中身なら同じファイルを使い回すので、同じ画面を何度撮っても増えない。
 * 画面には出さず、モデルへ渡すときにここから読み直す。
 */

/**
 * 保存できる画像の種類と、ファイルの拡張子。
 * 増やすときは、imageSize に大きさの読み取りも一緒に足すこと。
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** ファイル名に使えるハッシュの形。パスを組み立てる前に必ずこれで確かめる。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** ブラウザから渡されるファイル名の形（<sha256>.<拡張子>）。 */
const IMAGE_FILE_PATTERN = /^([0-9a-f]{64})\.([a-z0-9]+)$/;

/** ディレクトリ名。データディレクトリの直下に置く。 */
const IMAGES_DIR_NAME = "images";

/** 画像の実体を読む口。履歴を組み立てる側は、置き場を知らずにこれだけを使う。 */
export type ImageReader = {
  read(ref: ImageRef): Uint8Array | null;
};

export type ImageStore = ImageReader & {
  /** 画像を保存して参照を返す。同じ中身なら同じ参照になる。 */
  save(data: Uint8Array, mime: string): ImageRef;
  /** ブラウザからのファイル名（<sha256>.<拡張子>）で読む。知らない形なら null。 */
  readByName(file: string): { data: Uint8Array; mime: string } | null;
};

/** 画像の保存名。URL の末尾にもなる。 */
export function imageFileName(ref: ImageRef): string {
  const extension = IMAGE_EXTENSIONS[ref.mime];
  if (extension === undefined) throw new Error(`Unsupported image type: ${ref.mime}`);
  return `${ref.sha256}.${extension}`;
}

/** 画面から画像を開く URL。 */
export function imageUrl(ref: ImageRef): string {
  return `/api/images/${imageFileName(ref)}`;
}

/** 画像 1 枚の大きさ。 */
type ImageSize = { width: number; height: number };

/** 拡張子から mime を引くための、IMAGE_EXTENSIONS の逆向きの表。 */
const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_EXTENSIONS).map(([mime, extension]) => [extension, mime]),
);

export function createImageStore(dataDir: string): ImageStore {
  const imagesDir = join(dataDir, IMAGES_DIR_NAME);

  function fileFor(sha256: string, mime: string): string {
    return join(imagesDir, `${sha256}.${IMAGE_EXTENSIONS[mime]}`);
  }

  /** sha256 と mime から実体を読む。参照の形が正しくなければ null。 */
  function readStored(sha256: string, mime: string): Uint8Array | null {
    if (normalizeImageMime(mime) === null) return null;
    // 参照は保存済みの値だが、パスを組み立てる前に形を確かめる。
    // MCP サーバーのツール結果から作られた参照は、端末の外で決まった値でもある。
    if (!SHA256_PATTERN.test(sha256)) return null;

    const file = fileFor(sha256, mime);
    return existsSync(file) ? readFileSync(file) : null;
  }

  return {
    save(data, mime) {
      const type = normalizeImageMime(mime);
      if (type === null) {
        throw new Error(
          `Unsupported image type: ${mime} (only ${Object.keys(IMAGE_EXTENSIONS).join(", ")} are supported)`,
        );
      }

      const size = imageSize(data, type);
      const sha256 = createHash("sha256").update(data).digest("hex");
      const file = fileFor(sha256, type);

      if (!existsSync(file)) {
        mkdirSync(imagesDir, { recursive: true });
        writeFileSync(file, data);
      }

      return { sha256, mime: type, width: size.width, height: size.height };
    },

    read(ref) {
      const type = normalizeImageMime(ref.mime);
      return type === null ? null : readStored(ref.sha256, type);
    },

    readByName(file) {
      const match = IMAGE_FILE_PATTERN.exec(file);
      if (match === null) return null;

      const [, sha256, extension] = match;
      if (sha256 === undefined || extension === undefined) return null;

      const mime = MIME_BY_EXTENSION[extension];
      if (mime === undefined) return null;

      const data = readStored(sha256, mime);
      return data === null ? null : { data, mime };
    },
  };
}

/** 画像の種類を、保存に使う名前へ揃える。扱えない種類は null。 */
function normalizeImageMime(mime: string): string | null {
  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  // image/jpg は仕様外だが、そう返すサーバーがあるので jpeg として扱う。
  const normalized = type === "image/jpg" ? "image/jpeg" : type;
  return Object.hasOwn(IMAGE_EXTENSIONS, normalized) ? normalized : null;
}

function imageSize(data: Uint8Array, mime: string): ImageSize {
  switch (mime) {
    case "image/png":
      return pngSize(data);
    case "image/jpeg":
      return jpegSize(data);
    case "image/gif":
      return gifSize(data);
    case "image/webp":
      return webpSize(data);
    default:
      throw new Error(`Unsupported image type: ${mime}`);
  }
}

/** PNG の大きさを、先頭の IHDR チャンクから読む。 */
function pngSize(data: Uint8Array): ImageSize {
  if (data.length < 24) throw new Error("PNG data is too short");

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // 署名と、先頭のチャンクが IHDR であることを確かめてから大きさを読む。
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) {
    throw new Error("PNG signature is missing");
  }
  if (view.getUint32(12) !== 0x49484452) {
    throw new Error("PNG does not start with an IHDR chunk");
  }

  return positiveSize(view.getUint32(16), view.getUint32(20));
}

/** GIF の大きさを、論理画面の寸法（先頭 10 バイト）から読む。 */
function gifSize(data: Uint8Array): ImageSize {
  if (data.length < 10) throw new Error("GIF data is too short");

  const signature = String.fromCharCode(...data.subarray(0, 6));
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    throw new Error("GIF signature is missing");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return positiveSize(view.getUint16(6, true), view.getUint16(8, true));
}

/** フレーム開始マーカーのうち、大きさを持つもの（C4・C8・CC は別の用途なので除く）。 */
const START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** JPEG の大きさを、フレーム開始（SOF）セグメントの寸法から読む。 */
function jpegSize(data: Uint8Array): ImageSize {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error("JPEG signature is missing");
  }

  let offset = 2;
  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    // 0xFF の埋め草を読み飛ばして、実際のマーカーを取る。
    let marker = data[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      marker = data[offset + 1];
    }
    if (marker === undefined) break;

    // 長さを持たないマーカー（SOI・TEM・RSTn）。
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // SOF より先に走査が始まった（SOS）か、画像が終わった（EOI）。大きさは読めない。
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 4 > data.length) break;

    const length = (data[offset + 2]! << 8) | data[offset + 3]!;
    if (length < 2) throw new Error("JPEG segment length is invalid");

    const segmentEnd = offset + 2 + length;
    if (segmentEnd > data.length) break;

    if (START_OF_FRAME.has(marker)) {
      if (offset + 9 > data.length) break;
      const height = (data[offset + 5]! << 8) | data[offset + 6]!;
      const width = (data[offset + 7]! << 8) | data[offset + 8]!;
      return positiveSize(width, height);
    }

    offset = segmentEnd;
  }

  throw new Error("Could not read the JPEG size (no start-of-frame segment)");
}

/**
 * WebP の大きさを読む。
 * 拡張形式（VP8X）はキャンバスの寸法、非拡張形式は VP8 / VP8L のヘッダーを使う。
 */
function webpSize(data: Uint8Array): ImageSize {
  if (data.length < 16) throw new Error("WebP data is too short");
  if (fourCC(data, 0) !== "RIFF" || fourCC(data, 8) !== "WEBP") {
    throw new Error("WebP signature is missing");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 12;

  while (offset + 8 <= data.length) {
    const type = fourCC(data, offset);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + size > data.length) break;

    if (type === "VP8X") {
      if (size < 10) break;
      const width = 1 + (data[payload + 4]! | (data[payload + 5]! << 8) | (data[payload + 6]! << 16));
      const height = 1 + (data[payload + 7]! | (data[payload + 8]! << 8) | (data[payload + 9]! << 16));
      return positiveSize(width, height);
    }

    if (type === "VP8 ") {
      // 3 バイトのフレームタグのあとに、開始コード（9D 01 2A）と 14 ビットの寸法が続く。
      if (size < 10 || data[payload + 3] !== 0x9d || data[payload + 4] !== 0x01 || data[payload + 5] !== 0x2a) {
        break;
      }
      const width = view.getUint16(payload + 6, true) & 0x3fff;
      const height = view.getUint16(payload + 8, true) & 0x3fff;
      return positiveSize(width, height);
    }

    if (type === "VP8L") {
      // 署名（2F）のあとの 28 ビットに、幅-1 と高さ-1 が 14 ビットずつ入る。
      if (size < 5 || data[payload] !== 0x2f) break;
      const bits =
        data[payload + 1]! | (data[payload + 2]! << 8) | (data[payload + 3]! << 16) | (data[payload + 4]! << 24);
      return positiveSize((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }

    // チャンクは偶数バイト境界に揃えられる。
    offset = payload + size + (size % 2);
  }

  throw new Error("Could not read the WebP size");
}

function fourCC(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!);
}

/**
 * 大きさが分からないまま参照を保存すると、あとから画像と座標の対応が取れなくなる。
 * 0 は壊れた画像として失敗させる。
 */
function positiveSize(width: number, height: number): ImageSize {
  if (width === 0 || height === 0) {
    throw new Error(`Could not read the image size (${width}x${height})`);
  }
  return { width, height };
}
