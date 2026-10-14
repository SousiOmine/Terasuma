# Terasuma

ローカルで動く AI エージェントです。第 1 マイルストーンとして「ツールを持たない LLM とチャットできる最小の UI」を実装した状態です。

- 会話はこの端末の中だけに保存されます
- 既定では `127.0.0.1` のみに公開します（認証なし）
- 日本語を既定とし、英語に切り替えられます（左下の「設定」から）
- 使用するモデルとプロバイダは画面の「設定 > モデル」から設定します

## 必要なもの

- [Bun](https://bun.sh) 1.2 以降

## 使い方

```bash
bun install
bun run dev
```

`http://127.0.0.1:3000` を開きます。

初回は使用するモデルが未設定なので、チャット画面の案内から「設定 > モデル」を開き、「プロバイダを追加」で API キーを登録してください。手順は「[モデルとプロバイダの設定](#モデルとプロバイダの設定)」に書いています。

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

設定ファイルは起動時に読み、内容を検証します。無くても起動できますが、その場合は使用するモデルが未設定の状態で立ち上がります。

```json
{
  "model": "deepseek/deepseek-v4-pro",
  "providers": {
    "deepseek": { "apiKey": "sk-..." },
    "custom-1": {
      "baseUrl": "https://gateway.example.test/v1",
      "label": "社内ゲートウェイ",
      "apiKey": "sk-..."
    }
  },
  "port": 3000,
  "engine": "mastra"
}
```

使える項目は `model`、`providers`、`port`、`engine` の 4 つです。綴り違いに気づかないまま動くと、設定したつもりで効かない状態になります。そのため、未知の項目があると起動時にエラーになります。

- `model` は Mastra のモデルルーター形式の `provider/model`。画面の「既定のモデル」がここに入ります。
- `providers` のキーはプロバイダ名で、モデル ID の先頭部分と一致します。既知のプロバイダ（`deepseek` など）は `apiKey` だけを持ちます。`baseUrl` を持つものは OpenAI 互換の独自エンドポイントとして扱い、`label` に画面へ出す名前を持てます。
- 設定ファイルの中身が食い違っていると起動時にエラーになります。既知のプロバイダに `baseUrl` を書いた場合、独自エンドポイントに `baseUrl` が無い場合、既知のプロバイダに `apiKey` が無い場合、`model` が `provider/model` の形でない場合などです。

画面から設定を変えると、このファイルが書き換わります。手で編集した内容は、次に画面から変更したときに読み直して取り込みます。API キーは `.env` と同じく平文で保存されるので、置き場所の権限には気をつけてください。

## 設定

環境変数で渡します（Bun が `.env` を自動で読みます）。config.json より優先されます。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `TERASUMA_PORT` | `3000` | 待ち受けポート |
| `TERASUMA_CONFIG_DIR` | OS ごとの設定ディレクトリ | 設定ファイルの置き場 |
| `TERASUMA_DATA_DIR` | OS ごとのデータディレクトリ | 会話データの置き場 |
| `TERASUMA_ENGINE` | `mastra` | `mock` を指定するとモックの LLM になります（開発用） |

`TERASUMA_PORT` と `TERASUMA_ENGINE` は値を確かめます。設定ミスを既定値で隠さないためです。

モデルとプロバイダは config.json だけに書きます。設定画面と同じ 1 か所にまとめ、環境変数とどちらが効いているのか分からなくなる状態を避けるためです。

## モデルとプロバイダの設定

「設定 > モデル」で、使用するモデルとプロバイダを管理します。

プロバイダの追加は 3 段です。

1. 接続するプロバイダを選ぶ。DeepSeek、OpenAI、Anthropic、Google、OpenRouter、xAI、Groq、Mistral のほか、OpenAI 互換のエンドポイントと Ollama を並べています。
2. API キーを入れる（独自エンドポイントと Ollama ではベース URL と名前も入れる）。
3. 「接続を確認」が通ると、そのプロバイダで使えるモデルの一覧が出ます。使用するモデルを選んで追加します。

接続を確認できないままでは保存しません。設定に残るプロバイダは、常に疎通を確かめたものだけになります。

モデルの一覧はプロバイダの `/models` を叩いて取ります。登録した API キーで実際に使えるモデルが並ぶ代わりに、独自エンドポイントには `/models` が要ります。

追加したプロバイダは、カードの「設定を変更」「削除」で管理します。API キーは画面へ戻さないので、変更では空のままにすると保存済みのキーを使います。

既定のモデルは 1 つです。「モデルを変更」で、プロバイダごとのモデル一覧から選び直せます。プロバイダを削除しても既定のモデルは残るので、使えない状態になったときはチャット画面と設定画面が選び直しを案内します。

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
  config.ts           環境変数と config.json → 型付き設定（providers の検証と書き戻し）
  paths.ts            OS ごとの保存先の解決
  shared/
    types.ts          サーバとクライアントで共有する型
    model.ts          モデル ID（provider/model）の型と判定
    providers.ts      設定画面に並べるプロバイダのカタログ
    sse.ts            SSE フレームの符号化・復号
  server/
    server.ts         HTTP サーバの組み立て（Bun.serve）
    routes.ts         /api/* のハンドラと 1 ターン分のイベント列
    engine.ts         LLM 呼び出しのインタフェースとモデルの解決（MastraEngine / MockEngine）
    provider-models.ts  プロバイダの /models を叩いて接続を確かめる
    settings.ts       config.json を読み書きする設定ストア
    prompt.ts         system プロンプトと「モデルへ渡る入力」の定義
    store.ts          bun:sqlite によるセッション・メッセージの永続化
    errors.ts         エラーレスポンスの組み立て
  client/
    main.tsx          Preact のマウント
    state.ts          signals による状態と操作
    modelSettings.ts  モデル設定の状態と操作
    api.ts            REST と SSE の受信
    errors.ts         失敗を画面に出すための型
    providerText.ts   プロバイダ名の差し替え
    i18n/             日本語・英語の辞書
    components/       App / Sidebar / Modal / Button / Field / ErrorNotice / ChatView /
                      MessageBubble / Composer / SettingsView / ModelSettingsView /
                      ProviderWizard / ModelPickerDialog / ModelList / ConfirmDialog
tests/               store / SSE / i18n / パス解決 / 設定 / 設定ストア / プロバイダ接続 /
                     モデルの解決 / モデル設定 API / チャット API
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
- モデルとプロバイダは config.json にだけ置きます。環境変数と画面の二重管理にすると、どちらが効いているのか分からなくなるためです。
- モデルの指定が揃っていない状態は、モデルを呼ぶ前に理由付きで止めます。既定値で埋め合わせると、設定したつもりで応答が来ない状態になります。
- エラーは機械可読なコードで返し、画面に出す文言はクライアントの i18n で解決します。サーバを言語非依存に保つためです。
- 画面の言語だけはブラウザの `localStorage` に保存します。ブラウザが管理する領域なので、アプリ側からは置き場所を指定できません。

## まだ入っていないもの

ツール呼び出し / 承認フロー / podman コンテナ / ComputerUse・BrowserUse / エージェントプロファイル / 右ペイン / LAN・Tailscale 公開とトークン認証 / 自動アップデート。
