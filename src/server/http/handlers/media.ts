import type { FileStore } from "../../computer/files";
import type { ImageStore } from "../../computer/images";
import { ResourceNotFoundError } from "../../errors";
import type { ApiRequest } from "./shared";

/**
 * エージェントが送った画像とファイルを、ブラウザへ返す。
 *
 * URL は中身から決まる（画像は sha256、ファイルは中身の sha256）ので、
 * 同じ URL の中身は変わらない。長めにキャッシュさせる。
 */

/** 中身が変わらない URL のキャッシュ。 */
const CACHE_CONTROL = "public, max-age=86400";

export function mediaHandlers(deps: { images: ImageStore; files: FileStore }) {
  return {
    /** 画像。画面にそのまま表示する。 */
    readImage(req: ApiRequest<{ file: string }>): Response {
      const image = deps.images.readByName(req.params.file);
      if (image === null) throw new ResourceNotFoundError("media_not_found", `画像 ${req.params.file} はありません`);

      return new Response(new Uint8Array(image.data), {
        headers: {
          "Content-Type": image.mime,
          "Cache-Control": CACHE_CONTROL,
        },
      });
    },

    /** 画像以外のファイル。ダウンロードとして返す。 */
    readFile(req: ApiRequest<{ id: string }>): Response {
      const file = deps.files.read(req.params.id);
      if (file === null) throw new ResourceNotFoundError("media_not_found", `ファイル ${req.params.id} はありません`);

      return new Response(new Uint8Array(file.data), {
        headers: {
          "Content-Type": file.mime,
          // 日本語のファイル名もそのままダウンロード名になる。
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "Cache-Control": CACHE_CONTROL,
        },
      });
    },
  };
}
