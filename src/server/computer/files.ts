import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { safeFileName } from "./uploads";

/**
 * エージェントがユーザーへ送ったファイルを、データディレクトリに置く。
 *
 * 画像は images.ts が受け持つ。ここは画像以外（文書・アーカイブなど）の置き場。
 * 中身の sha256 を id にして、同じファイルを何度送っても増えないようにする。
 * 名前と種類は id の隣の JSON に残す（ブラウザへ返すときのファイル名と Content-Type に使う）。
 */

/** 置き場のディレクトリ名。データディレクトリの直下に置く。 */
const FILES_DIR_NAME = "files";

/** id に使える形。パスを組み立てる前に必ずこれで確かめる。 */
const ID_PATTERN = /^[0-9a-f]{64}$/;

/** 拡張子から決める Content-Type。分からない拡張子は application/octet-stream にする。 */
const MIME_TYPES: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".sh": "text/x-shellscript; charset=utf-8",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** 保存したファイルの、画面に出すための参照。 */
export type StoredFile = {
  /** 中身の sha256。URL と保存名になる。 */
  id: string;
  /** 画面に出す名前。 */
  name: string;
  /** バイト数。 */
  size: number;
  /** ブラウザへ返す Content-Type。 */
  mime: string;
  /** ブラウザから開く URL。 */
  url: string;
};

/** 保存したファイルの中身と、返すときの名前・種類。 */
export type FileContents = {
  data: Uint8Array;
  name: string;
  mime: string;
};

export type FileStore = {
  /** ファイルを保存して参照を返す。同じ中身なら同じ id になる。 */
  save(data: Uint8Array, name: string): StoredFile;
  /** 保存したファイルを読む。無ければ null。 */
  read(id: string): FileContents | null;
};

/** ファイル名から Content-Type を決める。 */
export function mimeOfFileName(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

type FileMetadata = {
  name: string;
  mime: string;
};

export function createFileStore(dataDir: string): FileStore {
  const filesDir = join(dataDir, FILES_DIR_NAME);

  function dataPath(id: string): string {
    return join(filesDir, id);
  }

  function metadataPath(id: string): string {
    return join(filesDir, `${id}.json`);
  }

  return {
    save(data, name) {
      const safeName = safeFileName(name);
      const id = createHash("sha256").update(data).digest("hex");
      const metadata: FileMetadata = { name: safeName, mime: mimeOfFileName(safeName) };

      mkdirSync(filesDir, { recursive: true });
      if (!existsSync(dataPath(id))) writeFileSync(dataPath(id), data);
      // 同じ中身を別の名前で送られたら、最後に送られた名前を表示に使う。
      writeFileSync(metadataPath(id), `${JSON.stringify(metadata)}\n`, "utf8");

      return { id, name: safeName, size: data.length, mime: metadata.mime, url: `/api/files/${id}` };
    },

    read(id) {
      if (!ID_PATTERN.test(id)) return null;
      if (!existsSync(dataPath(id))) return null;

      const raw: unknown = JSON.parse(readFileSync(metadataPath(id), "utf8"));
      if (typeof raw !== "object" || raw === null) {
        throw new Error(`ファイル ${id} の記録が壊れています`);
      }
      const { name, mime } = raw as Record<string, unknown>;
      if (typeof name !== "string" || typeof mime !== "string") {
        throw new Error(`ファイル ${id} の記録が壊れています`);
      }

      return { data: readFileSync(dataPath(id)), name, mime };
    },
  };
}
