# Terasuma 本体のイメージ。
# エージェントが操作するデスクトップ（Xvfb + Chromium）は container/desktop.Containerfile で別に作る。
# 配布と自動更新の設定（Quadlet）は container/quadlet/terasuma.container に置いてある。

# Bun の版は .bun-version が正典。CI はその値を build-args で渡す。
# ローカルで build するときのために、既定値も同じ版にしておく。
ARG BUN_VERSION=1.4.3

# 短い名前は registries.conf の設定に左右されるので、Docker Hub を明示する。
FROM docker.io/oven/bun:${BUN_VERSION} AS build

WORKDIR /app

# 依存の解決だけ先に行い、ソースを変えても install を使い回せるようにする。
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile

COPY scripts ./scripts
COPY src ./src
RUN bun run build


FROM docker.io/oven/bun:${BUN_VERSION}-slim

# Bun.serve の development を切る（本番の起動条件）。
ENV NODE_ENV=production

# podman は、ホストのソケットに繋いでコンピュータ用のコンテナを動かすために使う。
# エージェントの bash ツールは、このイメージではなくコンピュータのコンテナの中で動く。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates podman \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/dist ./dist
# ホストの podman でコンピュータ用イメージを build するときの材料。
COPY container/desktop.Containerfile container/entry.sh ./container/

# Bun は HTML のアセットを cwd から解決するので、dist を cwd にして起動する
# （package.json の start:dist と同じ）。
WORKDIR /app/dist

USER bun

CMD ["bun", "index.js"]
