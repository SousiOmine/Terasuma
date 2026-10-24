# Terasuma のセットアップ

Terasuma を Podman のコンテナとして動かす。
イメージは GitHub Actions が GHCR に公開し、`podman auto-update` が新しいイメージに追従する。
Terasuma は `127.0.0.1:3000` にだけ待ち受け、外からは SSH トンネルか Tailscale Serve で開く。

## 前提

- Linux。systemd の user ユニットと Quadlet が使えること（Podman 4.4 以降）。
- rootless の Podman。
- `loginctl` で linger を有効にできること（sudo）。
- x86_64。公開イメージは `linux/amd64` のみ。
- Tailscale を使う場合は tailnet、MagicDNS、HTTPS 証明書。
- モデルの API キー。起動後に画面から入れる。

初回はコンピュータ用イメージ（Chromium）をホストの Podman で build する。
そのため、ネットワークと数分の待ち時間が要る。

## イメージ

`ghcr.io/sousiomine/terasuma:latest` は Public で公開している。
`podman pull ghcr.io/sousiomine/terasuma:latest` で取得できる。
`latest` のほかに `sha-<コミット>` のタグがある。
特定の版に固定するときは `sha-` のタグを使う。

自分のアカウントで公開する場合は、`.github/workflows/image.yml` の `images:` と `container/quadlet/terasuma.container` の `Image=` を書き換える。
GHCR のパッケージを private にした場合は、各マシンで `podman login ghcr.io` が必要になる。

## Quadlet を置く

`container/quadlet/terasuma.container` を user の Quadlet ディレクトリに置く。

```sh
mkdir -p ~/.config/containers/systemd
cp container/quadlet/terasuma.container ~/.config/containers/systemd/
```

Quadlet の中の `%h` は、systemd がホームディレクトリに展開する。

ログアウト後も動かすために linger を有効にする。

```sh
sudo loginctl enable-linger "$USER"
```

unit を生成して起動する。

```sh
systemctl --user daemon-reload
systemctl --user enable --now podman.socket
systemctl --user start terasuma
```

`podman.socket` は、コンテナの中の Terasuma がホストの Podman に繋ぐために使う。
unit 側にも `Requires=podman.socket` を書いてある。

アプリのコンテナ名は `terasuma-app`、コンピュータのコンテナ名は `terasuma`。
名前を分けているのは、同じ名前を使うとホストのコンテナ一覧で衝突するため。

## 自動更新

`podman auto-update` のタイマーを有効にする。

```sh
systemctl --user enable --now podman-auto-update.timer
```

タイマーは既定で毎日 0 時台に動く。
`latest` の digest が変わっていれば、イメージを pull して `terasuma.service` を再起動する。

今すぐ更新するときは次を実行する。

```sh
podman auto-update
```

更新の有無だけを見るときは `--dry-run` を使う。

```sh
podman auto-update --dry-run
```

版を固定したいときは、Quadlet の `Image=` を `sha-<コミット>` に変える。
そのあと `systemctl --user daemon-reload` と `systemctl --user restart terasuma` を実行する。

## 画面を開く

同じマシンなら `http://127.0.0.1:3000/` を開く。
Terasuma は `127.0.0.1` にだけ待ち受ける。

3000 番がほかのプログラムに使われていると、Terasuma は起動に失敗する（黙って別のポートへ移らない。
Tailscale Serve や SSH トンネルは 3000 番を前提にしているため）。開発モード（`TERASUMA_DEV=1`）のときだけ、
空いているポートで起動する。

別のマシンから SSH で見るなら、手元でトンネルを張る。

```sh
ssh -L 3000:127.0.0.1:3000 <ユーザー>@<ホスト>
```

### Tailscale

Tailscale の Serve を使うと、アプリを loopback のまま tailnet に公開できる。
MagicDNS と HTTPS が有効になっていることを先に確認する。

```sh
sudo tailscale serve --bg --yes 3000
```

設定は tailscaled に保存され、再起動後も残る。
`tailscale serve status` で確認できる。
公開先は次の URL になる。

```
https://<マシン名>.<tailnet>.ts.net/
```

tailnet の外に出したくないので、`tailscale funnel` は使わない。

Serve の設定変更には root が要る。
毎回 sudo を避けるなら、一度だけ次を実行して operator を設定する。

```sh
sudo tailscale set --operator="$USER"
```

解除するときは次のコマンドを使う。
Serve の設定がすべて消えるので、ほかの用途で Serve を使っているときは注意する。

```sh
sudo tailscale serve reset
```

Tailscale 経由では、MCP サーバーの OAuth 認可は完了しない。
コールバックの URL が `http://127.0.0.1:3000` で組み立てられるため、リモートのブラウザではその端末の localhost を指してしまう。
API キーで繋ぐ MCP サーバーはこの制限を受けない。
`設定 > コネクタ` で行うコネクタの設定（GitHub の Personal Access Token、Discord の webhook URL）はコールバック URL を使わないので、Tailscale 経由でも完了する。

## 最初の設定

画面を開き、`設定 > モデル` でプロバイダと API キー、使うモデルを設定する。
設定は `~/.config/terasuma/config.json` に保存される。

エージェントにデスクトップを操作させるときは、`設定 > コンピュータ` で起動する。
初回は `container/desktop.Containerfile` からコンピュータ用イメージを build するため、数分かかる。
以降は build 済みのイメージを使い回す。
イメージには、エージェントがそのまま使える `git`、`tmux`、`pi`（pi-coding-agent）が入っている。

## GitHub のコネクタ

GitHub のリポジトリや API を使うときは、`設定 > コネクタ` で Personal Access Token を保存する。
トークンは GitHub の画面で発行する。Terasuma 側でアプリを登録する必要はない。

1. `設定 > コネクタ` の GitHub で「アプリの設定を開く」を押す。
   `scopes=repo,read:user` と説明が埋まった、トークン発行ページが開く。
2. 有効期限を選び、**Generate token** を押す。
3. 表示されたトークンをコピーし、Terasuma の GitHub の欄に貼り付けて保存する。

トークンは `~/.local/share/terasuma/connectors/github.json`（0600）に保存される。
接続すると、コンピュータのコマンドで `GH_TOKEN` と `GITHUB_TOKEN` が使える。
git は `git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' clone ...` のように使う。
URL にトークンを埋めると `git remote -v` の出力に現れ、会話の記録に残る。
`gh` コマンドはコンピュータのイメージに入っていない。API はエージェントの `app_request` から叩ける。

有効期限が切れると、`app_request` は 401 を返す。
そのときは新しいトークンを発行し、同じ欄に貼り直す。

## pi（コーディングエージェント）

pi（pi-coding-agent）はコンピュータの中に入っているコーディングエージェントです。
コードを書かせるときは、`設定 > コネクタ` の pi-coding-agent で、プロバイダを選び、
API キーを貼って「保存して接続する」を押します。
Terasuma がコンピュータの中の pi に設定を書き、実際に 1 回呼んで動くことを確かめます。

API キーはコンピュータの中の pi の設定にだけ保存され、Terasuma の設定ファイルには入りません。
接続している間は組み込みスキル `pi-coding` が使えるようになり、Tera は tmux 越しに pi を呼びます。

## Discord への送信

Discord へ通知を送るときは、チャンネルの **webhook URL** を `設定 > コネクタ` の Discord に保存する。
Discord は 1 枚のカードで、Tera ごとの欄を持つ。
送信先は Tera ごとに 1 つ。エージェントは `discord_send` でそのチャンネルへ投稿する。
webhook は投稿だけができるので、メッセージの読み取り・編集・リアクションはできない。

1. Discord で送信先のチャンネルを開き、`チャンネルの編集 > 連携サービス > ウェブフック` を選ぶ。
2. **新しいウェブフック** を作り、**ウェブフック URL をコピー** を押す。
3. Terasuma の `設定 > コネクタ` を開き、Discord の送信先にしたい Tera の欄へ URL を貼り付けて保存する。

保存する前に、Terasuma がその URL の webhook を読んで確かめる（webhook の名前とチャンネル ID が画面に出る）。
URL は `~/.local/share/terasuma/discord/<teraId>.json`（0600）に保存される。
エージェントは URL を直接見ない（`discord_send` が Terasuma の側で使う）。

エージェントにコネクタの設定を頼むこともできる。未接続のまま `discord_send` を呼ぶと `discord_connect` の案内が返り、
チャットにコネクタのカードが出る。カードに URL を貼っても同じ場所へ保存される。

webhook はメンションを通知しない（`@everyone` などを本文に書いても、そのままの文字で届く）。
短時間に送りすぎると Discord が 429 を返す。そのときは、結果に出る秒数だけ待ってから送り直す。

以前の Bot トークンの `~/.local/share/terasuma/connections/discord.json` は使われない。削除してよい。

## データの場所

Quadlet は、ホストで直接動かすときと同じパスをコンテナにマウントする。

| パス | 内容 |
|---|---|
| `~/.config/terasuma/config.json` | モデル、プロバイダ、MCP の設定 |
| `~/.local/share/terasuma/terasuma.db` | 会話の履歴 |
| `~/.local/share/terasuma/images/` | ツールが撮った画像 |
| `~/.local/share/terasuma/models-dev.json` | モデルカタログのキャッシュ |
| `~/.local/share/terasuma/connectors/` | コネクタのトークン（`github.json`、0600。バックアップに含める） |
| `~/.local/share/terasuma/discord/` | Tera ごとの Discord の webhook URL（`<teraId>.json`、0600。バックアップに含める） |
| `~/.local/share/terasuma/container/home/` | コンピュータのホーム（エージェントの read / write / edit / bash の場所。チャットで添付したファイルは `uploads/` に置かれる） |
| `~/.local/share/terasuma/container/home/.agents/skills/` | エージェントが作成したスキル。コンテナの中では `/home/agent/.agents/skills/` |

バックアップを取るときは、`~/.config/terasuma` と `~/.local/share/terasuma` をまとめてコピーすればよい。
コネクタのトークンと webhook の URL（`connectors/` と `discord/`）もこの中に入るので、バックアップの扱いには注意する。

```sh
tar czf terasuma-backup.tgz -C "$HOME" .config/terasuma .local/share/terasuma
```

## 状態とログ

```sh
systemctl --user status terasuma
systemctl --user status podman-auto-update.timer
podman logs -f terasuma-app
podman ps --filter name=terasuma-app
curl -s http://127.0.0.1:3000/api/container
```

`podman logs terasuma` はコンピュータ側のログになる。
アプリのログは `terasuma-app` で見る。

## 困ったとき

### アプリが起動しない

```sh
systemctl --user status terasuma
podman logs terasuma-app
```

イメージの取得に失敗している場合は、`ghcr.io/sousiomine/terasuma` が Public か、`podman login ghcr.io` が済んでいるかを確認する。

### `podman auto-update` が systemd に繋がらない

```
Error: dial unix /run/user/1000/systemd/private: connect: connection refused
```

このエラーは、systemd の user manager の private ソケットが古くなっているときに起きる。
user manager を re-exec してソケットを作り直す。

```sh
systemctl --user daemon-reexec
systemctl --user reset-failed podman-auto-update.service
podman auto-update --dry-run
```

### 自動更新が何も拾わない

Quadlet から生成された unit が無いと、`podman auto-update` は対象を見つけられない。
unit が生成されているかを確認する。

```sh
systemctl --user cat terasuma
systemctl --user show terasuma -p Environment | grep PODMAN_SYSTEMD_UNIT
```

### コンピュータが起動しない

```sh
podman logs terasuma
podman ps -a --filter name=terasuma
```

初回のイメージ build にはネットワークが要る。
`設定 > コンピュータ` の状態が `image_missing` のままなら、build が失敗している。

### 古いイメージが増える

Podman 4.9 の `podman auto-update` は、更新前のイメージを dangling で残すことがある。
ときどき削除する。

```sh
podman image prune -f
```

### Tailscale で開けない

`tailscale serve status` に Serve の設定が出ているかを確認する。
`serve config denied` と出たら、`sudo` を付けるか、operator を設定する。

## セキュリティ

Terasuma にはアプリ側の認証がない。
`127.0.0.1` に閉じておき、外から使うときは SSH トンネルか Tailscale Serve を使う。

この構成では、アプリのコンテナにホストの Podman ソケットを渡している。
コンピュータの起動と操作にはこれが要る。
エージェントの `read`、`write`、`edit`、`bash` は、そのソケットを持つアプリのコンテナではなく、
コンピュータの Debian コンテナの中で動く。ホストのファイルは読めない。
コンピュータとホストが共有するのは `~/.local/share/terasuma/container/home/` だけで、
ここはホストのユーザーからも読める。

`web_fetch` は、エージェントが Terasuma 自身の API やローカルのサービスを読まないよう、
localhost とプライベートアドレスを取得しない。リダイレクトの飛び先も同じ規則で確かめる。

Terasuma にアクセスできる人は、コンピュータの画面と、この共有フォルダの中身を操作できる。
tailnet に共有端末や信頼できない端末が入っているなら、Tailscale の ACL で Serve のポートへのアクセスを絞る。

モデルの API キーは `~/.config/terasuma/config.json` に保存される。
コネクタのトークンは `~/.local/share/terasuma/connectors/` に 0600 で保存される。
イメージには含まれない。
GHCR のイメージは Public なので、誰でも pull できる。

## リポジトリからイメージを作る

CI を使わずにローカルで build するときは、リポジトリのルートで次を実行する。

```sh
podman build -t localhost/terasuma:dev .
```

`master` への push で `.github/workflows/image.yml` が動く。
`check` が型検査とテストを通したあと、`publish` が `latest` と `sha-<コミット>` を GHCR へ push する。

## 動作を確認した環境

- Linux（systemd 255、ホストの Podman 4.9.3、イメージ内の Podman 5.4.2）
- イメージ内の Podman から、ソケット経由でホストの Podman 4.9.3 に接続できること
- Tailscale 1.104.1 の Serve 経由で HTML、CSS、JS、`/api/container` が返ること
- `podman auto-update` による pull と `terasuma.service` の再起動
