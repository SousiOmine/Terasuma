import { asSchema, generateText, jsonSchema, stepCountIs, streamText } from "ai";
import type { ModelMessage, Schema, ToolSet } from "ai";
import type { ConnectorToolsetProvider } from "../../connectors/tools";
import type { DiscordToolsetProvider } from "../../discord/tools";
import type { ImageStore } from "../../computer/images";
import type { IdentityStore } from "../identity";
import type { Skill, SkillFileStore } from "../skill-types";
import type {
  AttachmentToolsetProvider,
  CodingToolsetProvider,
  ComputerToolsetProvider,
  HistoryToolsetProvider,
  McpManageToolsetProvider,
  RoutineToolsetProvider,
  TeraToolsetProvider,
  ToolsetProvider,
  WebSearchToolsetProvider,
} from "../contracts";
import type { AgentEngine, CatalogReader, SettingsReader } from "./index";
import { createLanguageModel } from "../../provider/adapters";
import { toolResultTakesImages } from "../../provider/kinds";
import { reasoningProviderOptions } from "../../provider/reasoning";
import { type ResolvedModel, resolveModel } from "../../provider/routing";
import { teraWorkspaceInContainer } from "../../computer/workspaces";
import { buildSystemPrompt, imagesMessage, toModelMessages, type PendingImages } from "../prompt";
import { userContentForModel } from "../model-content";
import { createChatUiTools } from "../tools/ui";
import { createDiscoveryTools } from "../tools/discovery";
import { createToolRegistry } from "../tools/registry";
import { createSkillTools } from "../tools/skill";
import { createSkillManageTools, type SkillChange } from "../tools/skill-manage";
import { createIdentityTools } from "../tools/identity";
import { createSkillLibrary } from "../skills";
import { describeToolFailure } from "../tool-failure";
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
  /** コネクタ（トークン）のツール。 */
  connectors: ConnectorToolsetProvider;
  /** Discord の webhook（送信先は Tera ごと）のツール。 */
  discord: DiscordToolsetProvider;
  /** スケジュールされた実行（ルーチン）のツール。扱うルーチンは Tera ごと。 */
  routine: RoutineToolsetProvider;
  /** MCP サーバーを足す・消すツール。 */
  mcpManage: McpManageToolsetProvider;
  /** 新しい Tera を作るツール。 */
  tera: TeraToolsetProvider;
  /** コンテナのファイルとシェルのツール。相対パスと bash の cwd が Tera ごとに違うので、ターンごとに組む。 */
  coding: CodingToolsetProvider;
  images: ImageStore;
  /** models.dev のカタログ。プロバイダの呼び出し方を決めるのに使う。 */
  catalog: CatalogReader;
  /** エージェントが作ったスキルの置き場。 */
  skills: SkillFileStore;
  /** Tera の identity の読み書き。system プロンプトに載せる版と、書いた版を持つ。 */
  identity: IdentityStore;
  /** 接続状態などで変わる、組み込みの追加スキル。呼び出しのたびに評価する。 */
  extraSkills?: () => readonly Skill[];
};

export function createAiSdkEngine(options: AiSdkEngineOptions): AgentEngine {
  const {
    settings,
    mcp,
    computer,
    attachments,
    history,
    webSearch,
    connectors,
    discord,
    routine,
    mcpManage,
    tera,
    coding,
    images,
    catalog,
    skills,
    identity,
    extraSkills,
  } = options;

  // スキルの一覧はターンの開始時に読み直す。ツールの定義は変わらないので、ここで 1 度だけ組む。
  const library = createSkillLibrary(skills, extraSkills);
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
    async stream({ context, signal, teraId, replyLanguage, attach, takeSteering }) {
      const model = resolve();

      // ツールの結果に画像を置けるかはプロバイダ次第。置けない場合は user メッセージで渡す。
      const toolResultImages = toolResultTakesImages(model.provider.kind);

      // system プロンプトに載せる identity は、最後に要約を書き換えた時点の版（applied）。
      // 書き換えただけの版（content）は、次の圧縮まで使わない（プロンプトを組み直さない）。
      const appliedIdentity = identity.readIdentity(teraId).applied;

      // このターンの Tera の作業フォルダ。read / write / edit の相対パスと bash の cwd の基準になる。
      // system プロンプトにも載せる（この Tera の中では変わらないので、キャッシュは当たり続ける）。
      const workspace = teraWorkspaceInContainer(teraId);

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
      const [initialMcpTools, computerTools] = await Promise.all([mcp.toolset(), computer.toolset({ teraId })]);
      // コネクタのツール（app_connect_<id> と app_request）も、検索してから実行する。
      // Discord のツールは送信先が Tera ごとに決まるので、このターンの Tera で組む。
      // ルーチンのツールも、触れるルーチンがこのターンの Tera のものに限られるので、ここで組む。
      // 新しい Tera を作るツールも、作る先（作業フォルダの親）がアプリで決まるのでここで組む。
      // MCP サーバーを足す・消すツールも、設定と接続の実体がアプリで決まるのでここで組む。
      const connectorTools = connectors.toolset();
      const discordTools = discord.toolset({ teraId });
      const routineTools = routine.toolset({ teraId });
      const mcpManageTools = mcpManage.toolset();
      const teraTools = tera.toolset();

      // MCP のツールだけは、ターンの途中で設定が変わると中身が入れ替わる。
      // prepareStep で参照が変わったときだけ、この一式を組み直す。
      let mcpTools = initialMcpTools;
      const hiddenTools = () => ({
        ...mcpTools,
        ...computerTools,
        ...connectorTools,
        ...discordTools,
        ...teraTools,
        ...routineTools,
        ...mcpManageTools,
      });
      let registry = await createToolRegistry(await withShortToolErrors(hiddenTools()));

      // ターンの途中で MCP のツールが変わったら、スキルと同じく次のモデル呼び出しの前に知らせる。
      const mcpNotices: string[] = [];

      // コンテナのツール（read / write / edit / bash）は、この Tera の作業フォルダを基準にする。
      const codingTools = coding.toolset({ teraId });

      // 添付の口と相対パスの基準はターンごとに変わるので、ここで組む。
      const attachmentTools = attachments.toolset({ teraId, attach });

      // 過去の履歴を引く先はターンの対象の Tera なので、ここで組む。
      const historyTools = history.toolset({ teraId });

      // Web 検索は既定のプロバイダが設定されているときだけ 2 つのツールになる。
      const webTools = webSearch.toolset();

      const tools = await withShortToolErrors(
        withToolModelOutput(
          {
            ...codingTools,
            ...attachmentTools,
            ...chatUiTools,
            ...historyTools,
            ...webTools,
            ...createDiscoveryTools(() => registry),
            ...skillTools,
            ...skillManageTools,
            ...createIdentityTools({ store: identity, teraId }),
          },
          {
            includeImages: toolResultImages,
            images,
            onImages: (entry) => pendingImages.push(entry),
          },
        ),
      );

      // 上限で止まったかどうかを、finish のときに知れるようにする。
      const withinLimit = stepCountIs(MAX_STEPS_PER_TURN);
      let reachedStepLimit = false;

      const result = streamText({
        model: createLanguageModel(model),
        instructions: buildSystemPrompt(library.all(), appliedIdentity, workspace),
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
        // ターンの途中でスキルや MCP のツールが変わったときも、次の呼び出しの前に user メッセージで知らせる。
        // 利用者が途中で送った発言は、届いた順にそのまま足す（最新の指示として扱わせる）。
        prepareStep: async ({ messages: current }) => {
          // 設定が変わっていなければ mcp.toolset() は同じ参照を返し、接続も試さない。
          const refreshedMcpTools = await mcp.toolset();
          if (registryNeedsRebuild(mcpTools, refreshedMcpTools)) {
            const previous = mcpTools;
            mcpTools = refreshedMcpTools;
            registry = await createToolRegistry(await withShortToolErrors(hiddenTools()));
            mcpNotices.push(mcpChangeNotice(previous, mcpTools));
          }

          const appended: ModelMessage[] = [];

          if (!toolResultImages && pendingImages.length > 0) {
            const message = imagesMessage(pendingImages.splice(0), images);
            if (message !== null) appended.push(message);
          }

          if (skillNotices.length > 0) {
            appended.push({ role: "user", content: skillNotices.splice(0).join("\n\n") });
          }

          if (mcpNotices.length > 0) {
            appended.push({ role: "user", content: mcpNotices.splice(0).join("\n\n") });
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
 * MCP のツール一式を組み直す必要があるか。
 * mcp.toolset() は設定が変わっていなければ同じ参照を返すので、参照の比較だけで足りる。
 */
export function registryNeedsRebuild(previous: ToolSet, next: ToolSet): boolean {
  return previous !== next;
}

/**
 * 引数の検証に失敗したときの理由を短くする。
 * AI SDK は検証の例外の message をそのままモデルへ渡すので、Zod のダンプが届いてしまう。
 */
async function withShortToolErrors(tools: ToolSet): Promise<ToolSet> {
  const wrapped: ToolSet = {};

  for (const [name, definition] of Object.entries(tools)) {
    const schema = asSchema(definition.inputSchema);
    const validate = schema.validate;
    if (validate === undefined) {
      wrapped[name] = definition;
      continue;
    }

    const shortSchema: Schema<unknown> = jsonSchema(await schema.jsonSchema, {
      validate: async (value) => {
        const result = await validate(value);
        return result.success ? result : { success: false, error: new Error(describeToolFailure(name, result.error)) };
      },
    });
    wrapped[name] = { ...definition, inputSchema: shortSchema };
  }

  return wrapped;
}

/** 1 つの notice に名前を並べる上限。多すぎるときは件数だけを伝える。 */
const MAX_NOTICE_MCP_TOOLS = 5;

/**
 * ターンの途中で MCP のツールが変わったことを、モデルへ 1 文で知らせる。
 * 新しいツール名を数件だけ並べ、多すぎるときは件数だけを伝える。
 */
function mcpChangeNotice(previous: ToolSet, next: ToolSet): string {
  const added = Object.keys(next).filter((name) => previous[name] === undefined);
  const lines = ["The MCP tools changed during this turn. Find the new ones with tool_search."];

  if (added.length === 0) return lines.join(" ");
  if (added.length > MAX_NOTICE_MCP_TOOLS) {
    lines.push(`${added.length} new tools were added; search for them with tool_search.`);
    return lines.join(" ");
  }

  lines.push(`New tools: ${added.join(", ")}. Find one with tool_search and run it with tool_call.`);
  return lines.join(" ");
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
