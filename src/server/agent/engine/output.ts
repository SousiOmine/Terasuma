import type { ToolSet } from "ai";
import type { ImageStore } from "../../computer/images";
import type { PendingImages } from "../../conversation/prompt";
import { readStoredImages, readToolOutput, toolResultOutput } from "../tool-output";

/** ツールの戻り値を、モデルへ渡す形（本文 + 画像）に揃える。 */

/**
 * すべてのツールの結果を、モデルへ渡す形（本文 + 画像）に揃える。
 *
 * ツールの戻り値は文字列か { text, images } なので、そのまま渡すとオブジェクトが
 * JSON としてモデルに見えてしまう。ここで本文だけに開き、画像を置けるプロバイダには
 * content の file 部品として一緒に渡す。置けないプロバイダには本文だけを渡し、
 * 画像は prepareStep が user メッセージとして足す。
 */
export function withToolModelOutput(
  tools: ToolSet,
  options: {
    includeImages: boolean;
    images: ImageStore;
    /** 画像を結果に置けないときに、結果の直後の user メッセージへ回すために集める。 */
    onImages?: (entry: PendingImages) => void;
  },
): ToolSet {
  // 同じ呼び出しで toModelOutput が複数回呼ばれても、画像を二重に集めない。
  const collected = new Set<string>();

  const wrapped: ToolSet = {};

  for (const [name, definition] of Object.entries(tools)) {
    wrapped[name] = {
      ...definition,
      toModelOutput: ({ toolCallId, output }: { toolCallId: string; output: unknown }) => {
        const { text, images } = readToolOutput(output);

        // 画像を結果に置けないプロバイダでは、結果の直後の user メッセージとして渡す。
        // toModelOutput はステップの応答を組み立てるとき（prepareStep より前）に呼ばれる。
        if (!options.includeImages && images.length > 0 && !collected.has(toolCallId)) {
          collected.add(toolCallId);
          options.onImages?.({ label: `${name} call`, images });
        }

        return toolResultOutput({
          text,
          images: readStoredImages(images, options.images),
          failed: false,
          includeImages: options.includeImages,
        });
      },
    };
  }

  return wrapped;
}
