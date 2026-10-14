/**
 * 設定画面から追加できる「接続先を自分で決める」エンドポイントの雛形。
 * モデルを提供するプロバイダの一覧は models.dev のカタログ（サーバ側）が持つので、ここには置かない。
 */

/**
 * 名前を付けて追加するエンドポイントの雛形。
 * このエントリはプロバイダの種類ではなく 1 つの接続先を表すので、保存する id は追加のたびに作る。
 */
export type EndpointPreset = {
  /** 雛形を見分ける id。保存する id は uniqueId のときだけ連番で作る。 */
  id: string;
  /** 画面に出す名前。固有名詞なので翻訳せず、翻訳が要るものはクライアント側が差し替える。 */
  name: string;
  /** 追加時に最初から入れておくベース URL。利用者に入れさせる場合は null。 */
  defaultBaseUrl: string | null;
  /** 利用者に表示名を付けさせるかどうか。 */
  requiresLabel: boolean;
  /** 保存する id を連番にするかどうか（同じ種類を複数登録できる）。 */
  uniqueId: boolean;
};

/** 名前を付けて保存する、OpenAI 互換エンドポイントの雛形。 */
export const OPENAI_COMPATIBLE_TEMPLATE: EndpointPreset = {
  id: "custom",
  name: "OpenAI compatible",
  defaultBaseUrl: null,
  requiresLabel: true,
  uniqueId: true,
};

/** 設定画面に並べる順。上から順に、よく使うものと設定が簡単なものを置く。 */
export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [
  {
    id: "ollama",
    name: "Ollama",
    // Ollama の OpenAI 互換の口。既定の待ち受けポートは 11434。
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    requiresLabel: false,
    uniqueId: false,
  },
  OPENAI_COMPATIBLE_TEMPLATE,
];

export function findEndpointPreset(id: string): EndpointPreset | undefined {
  return ENDPOINT_PRESETS.find((entry) => entry.id === id);
}
