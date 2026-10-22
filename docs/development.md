# 開発

## 必要なもの

- Bun 1.4.3（CI と Containerfile と同じ版を使う）
- podman（コンピュータ機能を試すときだけ）

## 起動

```sh
bun install
bun run dev
```

`dev` は開発モード（`TERASUMA_DEV=1`）で、ソースを直接動かす。API キー無しで画面だけ見たいときは、モックのエンジンを使う。

```sh
TERASUMA_ENGINE=mock bun run dev
```

本番と同じ形（ビルドした成果物）で動かすときは、先にビルドする。

```sh
bun run build
bun run start:dist
```

`dist/` は git 管理外なので、`start:dist` の前に必ず `bun run build` を通す。

## 検査

```sh
bun run check      # 型・lint・テスト
bun run fmt        # 整形（Biome）
bun run test       # テストだけ
bun run test:live  # 実際のプロバイダに繋ぐ確認（API キーと podman が要る）
```

`test:live` はファイル名が `*.live.ts` なので、既定の `bun test` には含まれない。
実際の `config.json` とモデルを使うため、通信費がわずかにかかる。

## 設定

設定ファイルは `~/.config/terasuma/config.json`（Linux）。環境変数は次のものを使う。

| 変数 | 意味 |
| --- | --- |
| `TERASUMA_PORT` | 待ち受けるポート（既定 3000） |
| `TERASUMA_CONFIG_DIR` | 設定ファイルの置き場 |
| `TERASUMA_DATA_DIR` | 会話・画像・カタログの置き場 |
| `TERASUMA_ENGINE` | 使うエンジン（`ai-sdk` か `mock`） |
| `TERASUMA_DEV` | `1` で開発モード。既定は本番 |

`TERASUMA_ENGINE` は開発用の切り替えなので、`config.json` には書かない（環境変数だけで決める）。
本番は設定したポートで待つ。ポートが埋まっていると起動に失敗する（開発時だけ、空いているポートへ逃げる）。

コンピュータ（デスクトップのコンテナ）のコマンドへ渡す環境変数は、`config.json` の `env` に保存される。
ふだんは画面から設定する。エージェントが `computer_set_env` を呼ぶとチャットに入力欄が出て、入力した値は
モデルへ渡らずに保存される（設定画面には名前だけを出す）。値は `podman exec --env` で、コンテナの中で
動かすコマンドへ渡す。`config.json` は値を含むため、書き込み時に `0600` にする。

## スキル

エージェントが作ったスキルは、コンピュータのホームの中の `.agents/skills/<name>/SKILL.md` に置く。
これは Agent Skills のユーザー領域の慣例で、ホスト側では `~/.local/share/terasuma/container/home/.agents/skills/`、コンテナの中では `/home/agent/.agents/skills/` になる。
`SKILL.md` は YAML frontmatter と Markdown 本文を持つ。frontmatter の `name` と `description` を一覧に使い、本文は `skill` ツールで読んだときだけ渡す。
`skill_manage` が作成、更新、削除、一覧を受け持つ。読み書きは `server/agent/skill-files.ts`、frontmatter の解析は `Bun.YAML` を使う。
スキルの一覧は system プロンプトに載る。ターンの途中でスキルが変わったときは、そのターンの system プロンプトを組み直さず、次のモデル呼び出しの前に user メッセージで知らせる。
スキルはコンテナのホームの中にあるので、ホームを消すリセットでは一緒に消える。

## アプリの接続

アプリの接続には 2 種類ある（`server/connections/providers.ts` の `kind`）。

- `device`: Device Flow（RFC 8628）。GitHub のように、コードを画面に出してブラウザで承認する。`config.json` には Client ID だけを置く（client secret は使わない）。
- `bot`: 利用者が発行したトークンを貼る。Discord の bot のように、OAuth の同意画面では取れない資格情報を使う。`config.json` の Client ID は招待リンクに、トークンは API の呼び出しに使う。

```json
"connections": {
  "github": { "clientId": "Iv1.0123456789abcdef" },
  "discord": { "clientId": "123456789012345678" }
}
```

トークンは `config.json` ではなく、データディレクトリの `connections/<id>.json` に保存する（ディレクトリ 0700、ファイル 0600）。
`bot` のトークンは保存する前に、アカウントを読んで受け付けられるか確かめる（間違ったトークンを黙って保存しない）。
Device Flow はコールバック URL を使わないので、SSH トンネルでも Tailscale 経由でも認可を完了できる。
MCP サーバーの redirect 方式（`server/mcp/oauth.ts`）とはここが違う。`bot` もトークンを貼るだけなので、コールバック URL を使わない。

接続が得たトークンは、コンピュータのコマンドへ環境変数として渡す（GitHub は `GH_TOKEN` / `GITHUB_TOKEN`、Discord は `DISCORD_BOT_TOKEN`）。
同じ名前が `config.json` の `env` にある場合は、接続の値を優先する（接続し直した結果を使うため）。
モデルは値を直接見ないが、コンテナの中で `echo $DISCORD_BOT_TOKEN` を実行すれば読める（`computer_set_env` と同じ性質）。

エージェントは `computer_connect_app` で認可の完了を待ち、`app_request` で接続済みアプリの API を叩く。
どちらもツール一覧には載せず、`tool_search` で見つけて `tool_call` で実行する。
`app_request` の Authorization はプロバイダの `api.authorization` が決める（既定は `Bearer`、Discord は `Bot`）。
`app_request` のパスは接続先の API の origin に収まるものだけを受け付ける。

`connections` は新しい項目なので、これを知らない古い版へダウングレードすると、設定ファイルの
未知の項目として起動に失敗する（設定を消すか、新しい版へ戻す）。

## 構成

```
src/
  index.ts            起動と停止
  app.ts              依存の組み立て（合成ルート）
  server/http         ルートとハンドラ（Bun 依存はここだけ）
  server/agent        ターン・プロンプト・圧縮・ツール
  server/provider     種別表・呼び出し・カタログ・疎通確認
  server/mcp          MCP の接続と OAuth
  server/connections  アプリの接続（Device Flow / Bot トークン・トークン保存・ツール）
  server/computer     podman・画像・引き受け
  server/data         設定と会話の永続化
  client/lib          通信・失敗・待ち
  client/state        signal の状態
  client/ui           見た目の部品
  client/features     画面ごとの実装
  shared              client/server 共通（ほかに依存しない）
```

依存の向きは `tests/architecture.test.ts` が機械的に検査する。
新しい層を足すときは、このテストに規則を 1 行足す。

## 画面の幅

幅が 768px 未満（Tailwind の `md`）なら、狭い画面向けの見た目にする。768px 以上は変えない。
切り替えは CSS の `md:` だけで行い、画面の広さを JavaScript では見ない。

- サイドバーは左に並ばず、ヘッダーのメニューボタンで開くドロワーになる。
- コンピュータの画面は右ペインではなく、チャットに重ねた全画面になる。引き受け中は返事の入力欄をペインの中に出す（全画面だとチャットの入力欄に触れないため）。
- 設定のカテゴリは左ペインではなく、本文の上のタブになる。
- 1 行に収まらない項目（見出しとボタン、カードと操作）は `sm`（640px）未満で縦に積む。
- 狭い画面の入力欄は 16px にする。iOS がフォーカス時に行を拡大するのを防ぐ。

画面の高さは `dvh` で取る。スマホのブラウザはアドレスバーの伸縮で見える高さが変わるため、`100%` では下端の入力欄がはみ出す。

## 注意

- Tailwind のプラグイン設定は、`bunfig.toml`（開発サーバ）と `scripts/build.ts`（本番ビルド）の
  両方に要る。`bun build` の CLI は `bunfig.toml` の `[serve.static]` を読まないため。
  片方だけ直すと、CSS が未処理のまま出力される。
- 本番の `NODE_ENV` は `scripts/build.ts` がビルド時に埋め込む。起動側で前置する必要はない。
- `container/desktop.Containerfile` は、エージェントが操作するデスクトップのイメージ。
  リポジトリ直下の `Containerfile` は Terasuma 本体のイメージ。取り違えない。
