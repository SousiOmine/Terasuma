import type { ToolResultPart } from "ai";
import type { ImageRef } from "../shared/types";
import type { ImageReader } from "./images";

/**
 * ツールの戻り値から、モデルへ渡す本文と画像を取り出す。
 *
 * 画像を返すツールは { text, images } を返し、返さないツールはこれまでどおり文字列を返す。
 * 画像は保存した参照（ImageRef）で持ち、モデルへ渡す直前にここで実体を読む。
 */

/** ツール結果 1 件分の output。 */
type ToolResultOutput = ToolResultPart["output"];

/** 画像つきのツールの戻り値。画像を返さないツールは、これまでどおり文字列でよい。 */
export type ImageToolOutput = {
  text: string;
  images?: readonly ImageRef[];
};

/** ツール結果の content に置ける画像 1 枚分。 */
type ImageFilePart = Extract<Extract<ToolResultOutput, { type: "content" }>["value"][number], { type: "file" }>;

/** 保存済みの参照から、実際に読めた画像と file 部品。 */
export type StoredImages = {
  /** 読めた画像。参照と同じ順。 */
  images: ImageRef[];
  /** モデルへ渡す file 部品。images と同じ順。 */
  files: ImageFilePart[];
  /** 参照はあるが実体が無かった枚数。 */
  missing: number;
};

/** ツールの戻り値を、本文と画像の参照に分ける。 */
export function readToolOutput(value: unknown): { text: string; images: ImageRef[] } {
  if (typeof value === "object" && value !== null) {
    const { text, images } = value as { text?: unknown; images?: unknown };
    if (typeof text === "string") return { text, images: imageRefs(images) };
  }

  // 文字列を返すツール（read / bash / computer_click など）は、そのまま本文にする。
  if (typeof value === "string") return { text: value, images: [] };

  const json = JSON.stringify(value);
  return { text: json === undefined ? String(value) : json, images: [] };
}

/** 保存済みの参照から、画像の実体を読む。読めない画像は欠けた枚数として数える。 */
export function readStoredImages(images: readonly ImageRef[], store: ImageReader): StoredImages {
  const found: ImageRef[] = [];
  const files: ImageFilePart[] = [];
  let missing = 0;

  for (const image of images) {
    const data = store.read(image);
    if (data === null) {
      missing += 1;
      continue;
    }

    found.push(image);
    files.push({ type: "file", mediaType: image.mime, data: { type: "data", data } });
  }

  return { images: found, files, missing };
}

/**
 * ツールの結果を、モデルへ渡す形にする。
 *
 * プロバイダがツールの結果に画像を置ける場合は content に含める。
 * 置けない場合は本文だけを返し、呼び出し側が結果の直後に user メッセージとして渡す。
 * 参照はあるのに実体が無い場合は、黙って本文だけにすると画像を見たつもりで話が進むので、
 * 読めなかったことを本文に残す（どちらの渡し方でも同じ）。
 */
export function toolResultOutput(options: {
  text: string;
  images: StoredImages;
  failed: boolean;
  /** プロバイダがツールの結果に画像を置けるかどうか。 */
  includeImages: boolean;
}): ToolResultOutput {
  const text =
    options.images.missing === 0 ? options.text : `${options.text}\n(Could not read the stored image.)`;

  if (options.failed) return { type: "error-text", value: text };
  if (!options.includeImages || options.images.files.length === 0) return { type: "text", value: text };

  return {
    type: "content",
    value: [{ type: "text", text }, ...options.images.files],
  };
}

/** 参照の並びを、形の合うものだけに絞る（端末の外から届いた値をそのまま信じない）。 */
function imageRefs(value: unknown): ImageRef[] {
  if (!Array.isArray(value)) return [];

  const images: ImageRef[] = [];
  for (const entry of value) {
    const image = imageRefOf(entry);
    if (image !== null) images.push(image);
  }
  return images;
}

function imageRefOf(value: unknown): ImageRef | null {
  if (typeof value !== "object" || value === null) return null;

  const { sha256, mime, width, height } = value as Record<string, unknown>;
  if (typeof sha256 !== "string" || typeof mime !== "string") return null;
  if (typeof width !== "number" || typeof height !== "number") return null;

  return { sha256, mime, width, height };
}
