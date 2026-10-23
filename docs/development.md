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

## チャットの UI

エージェントは `chat_ui` ツールで、チャットにカード（文章・一覧・表・フローチャート・選択肢・フォーム）を出せる。
カードは専用の部品として保存せず、ツール呼び出しの引数（UI マークアップ）から画面が描く。
そのため、メッセージの種類や DB の形は増えていない。

マークアップは JSX に似た独自のタグで、HTML としては実行しない（スクリプト・CSS・イベント属性・URL は受け付けない）。
使えるタグは次のとおり。

- `<Card title="...">` — ルート。中にブロックを並べる
- `<Text>` / `<List ordered>` + `<Item>` / `<Table>` + `<Row>` + `<Cell>`
- `<Flow>` + `<Node id shape>` / `<Edge from to label dashed>` — 位置は画面が決める
- `<Choice multiple>` + `<Option description>` — 押すとラベルが発言になる
- `<Form submit>` + `<Field label type required placeholder>`（`select` は `<Option>` を子に持つ）

規則:

- 属性値はダブルクォート。`ordered` / `multiple` / `required` / `dashed` は値なしで書く。
- テキスト中の `<` `>` `&` は `&lt;` `&gt;` `&amp;` と書く（実体参照はこの 5 つだけ）。
- `Choice` か `Form` は 1 枚に 1 つまで。
- 解釈は `shared/ui-markup/`（limits / types / reader / build）が持ち、サーバの検証（ツール）と画面の描画で同じ関数を使う。
- 押した選択肢は、待ちではなく新しいユーザー発言として送る。応答中は押せない。
- フローチャートの位置は `client/ui/flow-layout.ts` が決める。DOM を使わないので、テストで重なりを確かめられる。
- 表のセルや図のノード数には上限がある（`UI_MARKUP_LIMITS`）。マークアップ全体は 20,000 文字まで。
- ツール呼び出しの引数は履歴に残るので、圧縮の要約に見せるときは 600 文字で切り詰める
  （`server/agent/compaction-text.ts`）。

## 画面の動き

面が現れるときの動きは、`client/styles.css` の `tera-fade-in` / `tera-rise-in` / `tera-pop-in` / `tera-pane-in` を使う。
長さと曲線は `--app-duration*` / `--app-ease*` を正典にし、Tailwind の `transition` の既定もここへ揃えてある。
動かすのは transform と opacity だけにする（配置を変えず、スクロール位置を崩さないため）。
`prefers-reduced-motion` が有効な端末では、アニメーションを付けない。

## 履歴の読み込み

画面は一度に 20 件だけ読む。上端に近づくと、その前の 20 件を自動で読む。
読み込みの間も、読んでいた位置が動かないようにスクロールを調整する。
発言を送ったときは、上へ遡って読んでいても末尾へ戻す（送った発言を見失わないようにするため）。
送信時の移動だけを滑らかにし、それ以降の追従は即座に合わせる。

`GET /api/teras/:id/messages` は問い合わせでページを指定する。

| パラメータ | 意味 |
| --- | --- |
| `limit` | 返す件数。必須。1〜100 の整数。 |
| `before` | この seq より前だけを読む。省略すると最新から。 |

応答は `{ messages, hasMore }`。`messages` は古い順、`hasMore` はそのページより古い発言が残っているか。

画面へ返すメッセージは、本文・添付・注記・`chat_ui` の呼び出しだけに絞る（`shared/display-parts.ts`）。
ツールの結果とほかの呼び出しは store にだけ残し、モデルの文脈（compaction）と `history_search` は full の parts を使う。
そのため、画面へ送る量を減らしても、モデルへ渡る内容は変わらない。

## 応答の途中で送る

エージェントが応答を生成している間も、入力欄からメッセージを送れる。
送った発言は `POST /api/teras/:id/steer` でそのまま履歴へ保存され、
走っているターンの次のモデル呼び出しの直前（AI SDK の `prepareStep`）に、
user メッセージとして文脈の末尾へ足される。
最後の呼び出しに間に合わなかった発言は、ターンを終える前に続けてもう一度応答を作る
（届いたのに返事が無いままにしない）。

- 発言の並びは保存した時点の seq で決まる。画面も末尾ではなく seq の位置へ挿すので、
  読み直したときと並びが変わらない。
- ターンが終わっていたら 409 `turn_not_running`。画面は同じ発言を新しいターンとして送り直す。
- 停止を押したターンには足さない（足しても応答しないため）。
- 画面を引き受けている間（`computer_ask_user`）の入力は、これまでどおりツールの戻り値になる。
- 選択肢カードは応答中に押せない（押した内容は新しい発言として扱うため）。

## スキル

エージェントが作ったスキルは、コンピュータのホームの中の `.agents/skills/<name>/SKILL.md` に置く。
これは Agent Skills のユーザー領域の慣例で、ホスト側では `~/.local/share/terasuma/container/home/.agents/skills/`、コンテナの中では `/home/agent/.agents/skills/` になる。
`SKILL.md` は YAML frontmatter と Markdown 本文を持つ。frontmatter の `name` と `description` を一覧に使い、本文は `skill` ツールで読んだときだけ渡す。
`skill_manage` が作成、更新、削除、一覧を受け持つ。読み書きは `server/agent/skill-files.ts`、frontmatter の解析は `Bun.YAML` を使う。
スキルの一覧は system プロンプトに載る。ターンの途中でスキルが変わったときは、そのターンの system プロンプトを組み直さず、次のモデル呼び出しの前に user メッセージで知らせる。
スキルはコンテナのホームの中にあるので、ホームを消すリセットでは一緒に消える。

## アイデンティティ

Tera は自分の identity（役割と、必要な知識）を持つ。identity は Tera ごとに SQLite の `tera_identity` に保存し、
2 つの本文を持つ。

- `content`: Tera が `identity` ツールで書いた最新の本文
- `applied`: system プロンプトに載っている版

system プロンプトは `applied` だけを読む。書いただけでは変わらず、圧縮が要約を書き換えたときに
`applied` が `content` へ切り替わる（`server/agent/compaction.ts`）。
書き換え直後にプロンプトを組み直さないのは、先頭が変わるとプロンプトキャッシュが外れるため。
圧縮はもともと要約を書き換えてキャッシュを切るので、identity も同じ瞬間に切り替える。

新しい Tera には、既定の役割（`DEFAULT_TERA_IDENTITY`）が `content` と `applied` の両方に入る。
`identity` ツールは `tool_search` を挟まず、モデルへ常に渡す。長さは 4,000 文字まで。

## アプリの接続

アプリの接続は、利用者が発行したトークンを貼る方式に統一している（`server/connections/providers.ts`）。
GitHub は Personal Access Token、Discord は Bot トークンを使う。
プロバイダの定義は、トークン欄の文言、要求する権限、コンピュータへ渡す環境変数の名前を持つ。

`config.json` に置くのは、招待リンクに使う Application ID だけ（Discord）。

```json
"connections": {
  "discord": { "clientId": "123456789012345678" }
}
```

`clientId` は Discord の Application ID（OAuth2 の client ID）を指す。

トークンは `config.json` ではなく、データディレクトリの `connections/<id>.json` に保存する（ディレクトリ 0700、ファイル 0600）。
保存する前に、アカウントを読んで受け付けられるか確かめる（間違ったトークンを黙って保存しない）。
トークンを貼るだけなので、コールバック URL を使わない。
SSH トンネルでも Tailscale 経由でも設定できる。
MCP サーバーの redirect 方式（`server/mcp/oauth.ts`）とはここが違う。

接続が得たトークンは、コンピュータのコマンドへ環境変数として渡す（GitHub は `GH_TOKEN` / `GITHUB_TOKEN`、Discord は `DISCORD_BOT_TOKEN`）。
同じ名前が `config.json` の `env` にある場合は、接続の値を優先する（接続し直した結果を使うため）。
モデルは値を直接見ないが、コンテナの中で `echo $DISCORD_BOT_TOKEN` を実行すれば読める（`computer_set_env` と同じ性質）。

エージェントは `computer_connect_app` でトークンの保存を待ち、`app_request` で接続済みアプリの API を叩く。
どちらもツール一覧には載せず、`tool_search` で見つけて `tool_call` で実行する。
`app_request` の Authorization はプロバイダの `api.authorization` が決める（既定は `Bearer`、Discord は `Bot`）。
`app_request` のパスは接続先の API の origin に収まるものだけを受け付ける。

`connections` は新しい項目なので、これを知らない古い版へダウングレードすると、設定ファイルの
未知の項目として起動に失敗する（設定を消すか、新しい版へ戻す）。

## 構成

```
src/
  index.ts            起動と停止
  app.ts              依存の組み立て（合成ルート。overrides で一部だけ差し替えられる）
  server/http         ルート表・ハンドラ・SSE・外部 HTTP の共通処理
  server/agent        ターン・プロンプト・圧縮・ツール（engine/ に分かれる）
  server/provider     種別表・呼び出し・カタログ・疎通確認
  server/mcp          MCP の接続（connection / transport / tools）と OAuth
  server/connections  アプリの接続（トークン保存・検証・ツール）
  server/computer     podman・画像・引き受け・契約値
  server/data         設定と会話の永続化（store/ と settings/ に分かれる）
  server/wait         中断で片付く待ち
  client/lib          通信・失敗・待ち
  client/state        signal の状態（resource.ts が読み込みの共通形）
  client/ui           見た目の部品（SecretInput・SectionHeader・ResourceList など）
  client/features     画面ごとの実装（通信は state 経由）
  shared/api          client/server で共有する API の型（message・settings・error）
  shared              client/server 共通の純関数（ほかに依存しない）
```

依存の向きは `tests/architecture.test.ts` が機械的に検査する。
新しい層を足すときは、このテストに規則を 1 行足す。

コンテナの契約値（DISPLAY、uid、gid、作業ディレクトリ、VNC のポート）は
`server/computer/contract.ts` を正典にする。イメージを作り直したときに値がずれていないかは、
コンテナの起動時に確かめ、ずれていれば起動を失敗させる。

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
