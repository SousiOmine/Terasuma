import { AppError } from "../errors";

/**
 * コンテナを操作できなかった理由。
 *
 * HTTP の状態は、失敗のコードから決まる（shared/api/error.ts の ERROR_STATUS）。
 * 画面の文言はクライアント側の i18n が決める。
 */
export type ContainerErrorCode = "container_build_failed" | "container_start_failed" | "container_not_running";

export class ContainerError extends AppError {
  constructor(code: ContainerErrorCode, message: string) {
    super(code, message);
  }
}
