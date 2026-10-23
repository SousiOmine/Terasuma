import { generateText, stepCountIs, streamText } from "ai";
import type { ModelMessage } from "ai";
import type { ConnectionToolsetProvider } from "../../connections/tools";
import type { ImageStore } from "../../computer/images";
import type { IdentityStore } from "../identity";
import type { SkillFileStore } from "../skill-types";
import type {
  AttachmentToolsetProvider,
  ComputerToolsetProvider,
  HistoryToolsetProvider,
  ToolsetProvider,
  WebSearchToolsetProvider,
} from "../contracts";
import type { CodingToolset } from "../tools/coding";
import type { AgentEngine, CatalogReader, SettingsReader } from "./index";
import { createLanguageModel } from "../../provider/adapters";
import { toolResultTakesImages } from "../../provider/kinds";
import { reasoningProviderOptions } from "../../provider/reasoning";
import { type ResolvedModel, resolveModel } from "../../provider/routing";
import { buildSystemPrompt, imagesMessage, toModelMessages, type PendingImages } from "../prompt";
import { userContentForModel } from "../model-content";
import { createChatUiTools } from "../tools/ui";
import { createDiscoveryTools } from "../tools/discovery";
import { createToolRegistry } from "../tools/registry";
import { createSkillTools } from "../tools/skill";
import { createSkillManageTools, type SkillChange } from "../tools/skill-manage";
import { createIdentityTools } from "../tools/identity";
import { createSkillLibrary } from "../skills";
import { toEngineStream } from "./stream";
import { withToolModelOutput } from "./output";

/** AI SDK でモデルを呼ぶエンジン。 */

/**
 * 1 ターンでモデルを呼ぶ回数の上限。
 *
 * ファイルを読み、直し、実行して確かめるようなコーディングの作業は何十ステップにもなる。
 * 5 では 1 回の依頼で終わらないので、実質的に止まらない高さにしてある。
 * それでも 0 にはしない。ツールの呼び出しが噛み合わずに繰り返されたとき、
 * 際限なくモデルを呼び続けて課金が止まらなくなるのを防ぐため、最後の歯止めは残す。
 * 依存側の既定値に任せると、こちらの意図と関係なく変わってしまうので、ここで決める。
 */
const MAX_STEPS_PER_TURN = 500;

export type AiSdkEngineOptions = {
  settings: SettingsReader;
  mcp: ToolsetProvider;
  computer: ComputerToolsetProvider;
  /** 画像やファイルをチャットへ添付するツール。 */
  attachments: AttachmentToolsetProvider;
  /** 過去の対話履歴を検索するツール。 */
  history: HistoryToolsetProvider;
  /** Web 検索とページ取得のツール。 */
  webSearch: WebSearchToolsetProvider;
  /** アプリの接続（OAuth）のツール。 */
  connections: ConnectionToolsetProvider;
  /** コンテナのファイルとシェルのツール。 */
  coding: CodingToolset;
  images: ImageStore;
  /** models.dev のカタログ。プロバイダの呼び出し方を決めるのに使う。 */
  catalog: CatalogReader;
  /** エージェントが作ったスキルの置き場。 */
  skills: SkillFileStore;
  /** Tera の identity の読み書き。system プロンプトに載せる版と、書いた版を持つ。 */
  identity: IdentityStore;
};

export function createAiSdkEngine(options: AiSdkEngineOptions): AgentEngine {
  const {
    settings,
    mcp,
    computer,
    attachments,
    history,
    webSearch,
    connections,
    coding,
    images,
    catalog,
    skills,
    identity,
  } = options;

  // スキルの一覧はターンの開始時に読み直す。ツールの定義は変わらないので、ここで 1 度だけ組む。
  const library = createSkillLibrary(skills);
  const skillTools = createSkillTools(library);

  // チャットへ UI を送るツール。ターンによらず同じなので、ここで 1 度だけ組む。
  const chatUiTools = createChatUiTools();

  /** 設定とカタログから、今回のモデルを決める。呼び出しのたびに読み直す。 */
  function resolve(): ResolvedModel {
    const resolution = resolveModel(settings.read(), catalog.snapshot());
    if (!resolution.ok) throw new Error(resolution.detail);
    return resolution.model;
  }

  return {
    name: "ai-sdk",
    async stream({ context, signal, teraId, replyLanguage, attach, takeSteering }) {
      const model = resolve();

      // ツールの結果に画像を置けるかはプロバイダ次第。置けない場合は user メッセージで渡す。
      const toolResultImages = toolResultTakesImages(model.provider.kind);

      // system プロンプトに載せる identity は、最後に要約を書き換えた時点の版（applied）。
      // 書き換えただけの版（content）は、次の圧縮まで使わない（プロンプトを組み直さない）。
      const appliedIdentity = identity.readIdentity(teraId).applied;

      // 畳んだ要約を先頭に、生の履歴をその後ろに置く。生の履歴には要約も並べ替えもしない
      // （プロンプトキャッシュが当たり続けるようにするため）。
      // 今日の日付は履歴の末尾に置く（先頭を変えず、履歴検索の期間指定に使えるようにする）。
      const messages = toModelMessages(context, images, replyLanguage, { toolResultImages }, Date.now());

      // 思考強度はプロバイダごとに渡し方が違うので、ここで組み立てて呼び出しごとに渡す。
      const providerOptions = reasoningProviderOptions(model.provider, model.reasoningEffort);

      // 画像を結果に置けないプロバイダのために、このターンで届いた画像を集める。
      // 次のステップの直前に user メッセージとして足す。
      const pendingImages: PendingImages[] = [];

      // ターンの途中でスキルが変わったら、次のモデル呼び出しの前に user メッセージで知らせる。
      // system プロンプトはターンの開始時に組んだままにし、そのターンの文脈を組み直さない。
      const skillNotices: string[] = [];
      const skillManageTools = createSkillManageTools({
        library,
        store: skills,
        onChange: (change) => skillNotices.push(skillNotice(change)),
      });

      // MCP とコンテナのツールは、モデルのツール一覧へは載せない。
      // 名前・説明・引数スキーマは tool_search で取り寄せ、tool_call で実行する
      // （サーバーが増えても、使わないツールの定義で毎回の文脈が膨らまないようにするため）。
      // 一覧は呼び出しのたびに組み直すので、設定画面でサーバーを足しても作り直さずに済む。
      const [mcpTools, computerTools] = await Promise.all([mcp.toolset(), computer.toolset({ teraId })]);
      // アプリの接続ツール（computer_connect_app と app_request）も、検索してから実行する。
      const registry = await createToolRegistry({ ...mcpTools, ...computerTools, ...connections.toolset() });

      // 添付の口はターンごとに差し替わるので、ここで組む。
      const attachmentTools = attachments.toolset({ attach });

      // 過去の履歴を引く先はターンの対象の Tera なので、ここで組む。
      const historyTools = history.toolset({ teraId });

      // Web 検索は既定のプロバイダが設定されているときだけ 2 つのツールになる。
      const webTools = webSearch.toolset();

      const tools = withToolModelOutput(
        {
          ...coding,
          ...attachmentTools,
          ...chatUiTools,
          ...historyTools,
          ...webTools,
          ...createDiscoveryTools(registry),
          ...skillTools,
          ...skillManageTools,
          ...createIdentityTools({ store: identity, teraId }),
        },
        {
          includeImages: toolResultImages,
          images,
          onImages: (entry) => pendingImages.push(entry),
        },
      );

      // 上限で止まったかどうかを、finish のときに知れるようにする。
      const withinLimit = stepCountIs(MAX_STEPS_PER_TURN);
      let reachedStepLimit = false;

      const result = streamText({
        model: createLanguageModel(model),
        instructions: buildSystemPrompt(library.all(), appliedIdentity),
        messages,
        abortSignal: signal,
        ...(Object.keys(tools).length === 0 ? {} : { tools }),
        stopWhen: (options) => {
          const stop = withinLimit(options);
          if (stop) reachedStepLimit = true;
          return stop;
        },
        ...(providerOptions === null ? {} : { providerOptions }),
        // 画像を結果に置けないプロバイダでは、結果の直後に user メッセージとして足し、
        // どの呼び出しの画像かを本文で示す（プロバイダの役割の並びも壊さない）。
        // ターンの途中でスキルが変わったときも、次の呼び出しの前に user メッセージで知らせる。
        // 利用者が途中で送った発言は、届いた順にそのまま足す（最新の指示として扱わせる）。
        prepareStep: ({ messages: current }) => {
          const appended: ModelMessage[] = [];

          if (!toolResultImages && pendingImages.length > 0) {
            const message = imagesMessage(pendingImages.splice(0), images);
            if (message !== null) appended.push(message);
          }

          if (skillNotices.length > 0) {
            appended.push({ role: "user", content: skillNotices.splice(0).join("\n\n") });
          }

          for (const message of takeSteering()) {
            appended.push({ role: "user", content: userContentForModel(message) });
          }

          return appended.length === 0 ? undefined : { messages: [...current, ...appended] };
        },
      });

      return toEngineStream(result.fullStream, () => reachedStepLimit);
    },

    /**
     * ツールを使わない 1 回の生成（要約）。
     * 指示もプロンプトも呼び出しごとに変わるので、その場で組み立てる。
     */
    async complete({ instructions, prompt, signal, maxOutputTokens }) {
      const result = await generateText({
        model: createLanguageModel(resolve()),
        instructions,
        prompt,
        abortSignal: signal,
        maxOutputTokens,
      });
      return result.text;
    },
  };
}

/**
 * ターンの途中で起きたスキルの変更を、モデルへ 1 文で知らせる。
 * そのターンの system プロンプトはターンの開始時に組んだままなので、一覧はまだ古い。
 */
function skillNotice(change: SkillChange): string {
  if (change.action === "create") {
    const description = change.description === undefined ? "" : ` (${change.description})`;
    return `A skill was created during this turn: "${change.name}"${description}. The system prompt still has the catalog from the start of this turn. Load it now with skill("${change.name}").`;
  }
  if (change.action === "update") {
    return `A skill was updated during this turn: "${change.name}". Load it again with skill("${change.name}") to see the new content.`;
  }
  return `A skill was deleted during this turn: "${change.name}". Do not use it again.`;
}
