# Terasuma

ローカルで動く AI エージェントです。第 1 マイルストーンとして「ツールを持たない LLM とチャットできる最小の UI」を実装した状態です。

- 会話はこの端末の中だけに保存されます
- 既定では `127.0.0.1` のみに公開します（認証なし）
- 日本語を既定とし、英語に切り替えられます（左下の「設定」から）

## 必要なもの

- [Bun](https://bun.sh) 1.2 以降

## 使い方

```bash
bun install
cp .env.example .env   # 使うプロバイダの API キーを書く
bun run dev
```

`http://127.0.0.1:3000` を開きます。

### API キー無しで画面だけ試す

モックの LLM で UI とストリーミングを確認できます。`TERASUMA_ENGINE=mock` を明示したときだけ使われ、自動で選ばれることはありません。

```bash
TERASUMA_ENGINE=mock bun run dev
```

## 保存先

設定と会話データは、OS ごとの標準的な場所に分けて置きます。

| OS | 設定（config.json） | データ（terasuma.db） |
| --- | --- | --- |
| Windows | `%APPDATA%\Terasuma` | `%LOCALAPPDATA%\Terasuma` |
| macOS | `~/Library/Application Support/Terasuma/` | 同じ場所 |
| Linux | `$XDG_CONFIG_HOME`（既定は `~/.config/terasuma/`） | `$XDG_DATA_HOME`（既定は `~/.local/share/terasuma/`） |

Windows で設定とデータを分けているのは、`%APPDATA%` が別のマシンへ同期される場所だからです。SQLite の DB は、同期の途中でファイルの一部だけが渡ると開けなくなることがあるため、`%LOCALAPPDATA%` に置きます。

`TERASUMA_CONFIG_DIR` と `TERASUMA_DATA_DIR` を設定すれば、それぞれの場所を差し替えられます。

### config.json

設定ファイルは起動時に読みます。無くても既定値で動きます。

```json
{
  "model": "deepseek/deepseek-flash",
  "port": 3000,
  "engine": "mastra",
  "baseUrl": "https://example.test/v1",
  "apiKey": "..."
}
```

使える項目は `model`、`baseUrl`、`apiKey`、`port`、`engine` の 5 つです。綴り違いに気づかないまま動くと、設定したつもりで効かない状態になります。そのため、未知の項目があると起動時にエラーになります。

設定の優先順位は「環境変数、config.json、既定値」の順です。環境変数はその場限りの上書きとして使えます。API キーは `.env` と同じく平文で保存されるので、置き場所の権限には気をつけてください。

## 設定

環境変数で渡します（Bun が `.env` を自動で読みます）。config.json より優先されます。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `TERASUMA_MODEL` | `deepseek/deepseek-flash` | Mastra のモデルルーター形式 `provider/model` |
| `DEEPSEEK_API_KEY` など | （なし） | 使うプロバイダの API キー。Mastra がプロバイダごとの変数を読みます |
| `TERASUMA_BASE_URL` | （なし） | OpenAI 互換の独自エンドポイントを使う場合のみ |
| `TERASUMA_API_KEY` | （なし） | 上記エンドポイントを使う場合のキー |
| `TERASUMA_PORT` | `3000` | 待ち受けポート |
| `TERASUMA_CONFIG_DIR` | OS ごとの設定ディレクトリ | 設定ファイルの置き場 |
| `TERASUMA_DATA_DIR` | OS ごとのデータディレクトリ | 会話データの置き場 |
| `TERASUMA_ENGINE` | `mastra` | `mock` を指定するとモックの LLM になります（開発用） |

`TERASUMA_MODEL` は `provider/model` の形でないと起動時にエラーになります。`TERASUMA_PORT` と `TERASUMA_ENGINE` も値を確かめます。設定ミスを既定値で隠さないためです。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `bun run dev` | 開発サーバ（HMR・ソースマップあり） |
| `bun run start` | 本番モードで起動 |
| `bun run build` | `dist/` にバンドル |
| `bun test` | テスト |
| `bun run typecheck` | 型チェック |
| `bun run check` | 型チェック + テスト |

## 構成

```
src/
  index.ts            起動（設定読み込み → DB 初期化 → サーバ起動）
  config.ts           環境変数と config.json → 型付き設定
  paths.ts            OS ごとの保存先の解決
  shared/
    types.ts          サーバとクライアントで共有する型
    sse.ts            SSE フレームの符号化・復号
  server/
    server.ts         HTTP サーバの組み立て（Bun.serve）
    routes.ts         /api/* のハンドラと 1 ターン分のイベント列
    engine.ts         LLM 呼び出しのインタフェース（MastraEngine / MockEngine）
    prompt.ts         system プロンプトと「モデルへ渡る入力」の定義
    store.ts          bun:sqlite によるセッション・メッセージの永続化
    errors.ts         エラーレスポンスの組み立て
  client/
    main.tsx          Preact のマウント
    state.ts          signals による状態と操作
    api.ts            REST と SSE の受信
    i18n/             日本語・英語の辞書
    components/       App / Sidebar / ChatView / MessageBubble / Composer / SettingsView
tests/               store / SSE / i18n / パス解決 / 設定 / チャット API
```

### プロンプトキャッシュを当て続ける方針

DeepSeek 系のキャッシュは、リクエストの先頭が前回と一致するほど当たります。次の規則を守っています。

1. system プロンプトは完全な定数です（`src/server/prompt.ts`）。日時や件数を混ぜません。
2. モデルへは保存済み履歴をそのまま渡します。要約・言い換え・並べ替えをしません。
3. 履歴は追記専用です。今回は切り詰めを行いません。
4. 可変の情報を渡したくなったら、履歴の末尾（最後の user メッセージの後ろ）に置きます。

`tests/prompt-cache.test.ts` が、規則 2 と 3 を常に満たしているかを確認します。トークン使用量（キャッシュに当たった分を含む）はメッセージと一緒に保存しています。

### 設計上の割り切り

- Mastra の Memory は使っていません。モデルへ渡す文脈を自分で完全に制御し、キャッシュが当たり続けるようにするためです。
- LLM 呼び出しは `AgentEngine` インタフェースを通します。将来ツールや承認フローを足すときも、このインタフェースの内側だけで完結します。
- エラーは機械可読なコードで返し、画面に出す文言はクライアントの i18n で解決します。サーバを言語非依存に保つためです。
- 画面の言語だけはブラウザの `localStorage` に保存します。ブラウザが管理する領域なので、アプリ側からは置き場所を指定できません。

## まだ入っていないもの

ツール呼び出し / 承認フロー / podman コンテナ / ComputerUse・BrowserUse / エージェントプロファイル / 右ペイン / LAN・Tailscale 公開とトークン認証 / 自動アップデート / WebUI からの初期設定。
