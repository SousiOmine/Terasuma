import type { AppConfig } from "../../../config";
import { createAiSdkEngine, type AiSdkEngineOptions } from "./sdk";
import { createMockEngine } from "./mock";
import type { AgentEngine } from "./contract";

/**
 * エンジンの組み立て。
 *
 * 「何を渡し、何を受け取るか」は ./contract.ts、AI SDK の呼び出し方は ./sdk.ts、
 * ストリームの読み替えは ./stream.ts、ツール結果の変換は ./output.ts、
 * モックは ./mock.ts にある。ここは設定に応じて実装を選ぶだけ。
 */

/** エンジンの契約を、これまでどおりの名前でも読めるようにしておく。 */
export type {
  AgentEngine,
  CatalogReader,
  CompleteInput,
  EngineEvent,
  EngineInput,
  EngineStream,
  SettingsReader,
} from "./contract";

/** エンジンを組み立てるのに必要なもの。AI SDK の実装が要るものに、使う実装の種別を足す。 */
export type CreateEngineOptions = AiSdkEngineOptions & { config: AppConfig };

/**
 * 設定された実装でエンジンを作る。モックは開発・テスト専用で、既定にはならない。
 * 依存の一覧は AiSdkEngineOptions が正典なので、ここでは転記しない。
 */
export function createEngine(options: CreateEngineOptions): AgentEngine {
  if (options.config.engine === "mock") return createMockEngine();
  return createAiSdkEngine(options);
}
