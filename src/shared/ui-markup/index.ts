/**
 * チャットに描くカードのマークアップ。
 *
 * HTML としては実行しない（スクリプト・CSS・イベント属性・URL は受け付けない）。
 * 解釈はサーバの検証と画面の描画で同じ関数を使う。
 */

export { UI_MARKUP_LIMITS } from "./limits";
export { interactiveBlock } from "./types";
export type {
  UiBlock,
  UiChoiceBlock,
  UiField,
  UiFieldType,
  UiFlowBlock,
  UiFlowEdge,
  UiFlowNode,
  UiFlowShape,
  UiFormBlock,
  UiListBlock,
  UiOption,
  UiParseResult,
  UiTableBlock,
  UiTextBlock,
  UiView,
} from "./types";
export { parseUiMarkup } from "./build";
