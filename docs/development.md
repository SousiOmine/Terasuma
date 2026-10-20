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

## 構成

```
src/
  index.ts            起動と停止
  app.ts              依存の組み立て（合成ルート）
  server/http         ルートとハンドラ（Bun 依存はここだけ）
  server/agent        ターン・プロンプト・圧縮・ツール
  server/provider     種別表・呼び出し・カタログ・疎通確認
  server/mcp          MCP の接続と OAuth
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

## 注意

- Tailwind のプラグイン設定は、`bunfig.toml`（開発サーバ）と `scripts/build.ts`（本番ビルド）の
  両方に要る。`bun build` の CLI は `bunfig.toml` の `[serve.static]` を読まないため。
  片方だけ直すと、CSS が未処理のまま出力される。
- 本番の `NODE_ENV` は `scripts/build.ts` がビルド時に埋め込む。起動側で前置する必要はない。
- `container/desktop.Containerfile` は、エージェントが操作するデスクトップのイメージ。
  リポジトリ直下の `Containerfile` は Terasuma 本体のイメージ。取り違えない。
