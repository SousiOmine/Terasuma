# 短い名前は registries.conf の設定に左右されるので、Docker Hub を明示する。
FROM docker.io/debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
# git と tmux は、エージェントがコンテナの中でそのまま作業に使うので最初から入れておく。
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11-utils x11vnc openbox xdotool scrot imagemagick \
      websockify socat \
      xterm fonts-noto-cjk dbus-x11 \
      chromium \
      sudo curl ca-certificates \
      git tmux \
 && rm -rf /var/lib/apt/lists/*

# pi（pi-coding-agent）は、エージェントがコンテナの中で使うコーディングエージェント。
# pi 1.x は Node.js 22.19 以上を要求する。Debian の nodejs は 18 なので、
# nodejs.org の公式ビルドを /usr/local（/usr/bin より先に PATH が通る）に置き、
# apt のリポジトリを増やさずに済ませる。
# 版は再現できるよう固定する。上げるときは、ここの 2 つの版を書き換えてイメージを作り直す。
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "no Node.js build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/node.tar.gz \
      "https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-${node_arch}.tar.gz"; \
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.gz; \
    npm install --global --no-fund --no-audit @earendil-works/pi-coding-agent@1.3.0; \
    rm -rf /root/.npm

# エージェントが使うユーザー。root で動かすと Chromium の sandbox が使えず、
# マウントしたフォルダの中身が root の持ち物になる。
RUN useradd --create-home --uid 1000 --shell /bin/bash agent \
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent

COPY entry.sh /usr/local/bin/entry.sh
RUN chmod 0755 /usr/local/bin/entry.sh

# 画面を触るコマンド（xdotool / import / chromium）は、この値が無いと
# どの X サーバーを見ればよいか分からず失敗する。entry.sh の export は exec には届かない。
ENV DISPLAY=:99

USER agent
WORKDIR /home/agent
CMD ["/usr/local/bin/entry.sh"]
