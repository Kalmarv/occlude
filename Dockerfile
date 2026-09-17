# syntax=docker/dockerfile:1.7
#
# The reference build of occlude, from a clean checkout. One image proves the
# whole definition of done: every stage below `verified` has run `pnpm check`
# (Rust tests, TS tests, typechecks, docs, the ink oracle, the build, the
# wasm byte match) plus the two smoke tests through the compiled wasm.
#
#   pnpm docker:build          build + verify   (docker compose build)
#   pnpm docker:up             serve the studio (docker compose up -d)
#
# Cache mounts keep the cargo registry, the cargo target dir and the pnpm
# store on the host between builds, so a source change rebuilds only what
# changed; a `docker builder prune` returns to the cold path, which must
# still succeed (nothing prebuilt is copied in — see .dockerignore).
#
# Supported platform: linux/amd64. Pins live here and in rust-toolchain.toml,
# .node-version and the root package.json `packageManager` field; update them
# together (docs/architecture.md, "Build and verification").

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

# ---------------------------------------------------------------- toolchain
FROM ${NODE_IMAGE} AS toolchain
ARG PNPM_VERSION=10.30.1
ARG RUST_VERSION=1.98.0
ARG WASM_PACK_VERSION=0.13.1
ARG WASM_PACK_SHA256=c539d91ccab2591a7e975bcf82c82e1911b03335c80aa83d67ad25ed2ad06539
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    PNPM_HOME=/usr/local/pnpm-store \
    CARGO_BUILD_JOBS=4 \
    CI=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@${PNPM_VERSION}
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
      --default-toolchain ${RUST_VERSION} --target wasm32-unknown-unknown \
 && rustc --version && cargo --version
RUN curl -sSfL -o /tmp/wasm-pack.tgz \
      https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz \
 && echo "${WASM_PACK_SHA256}  /tmp/wasm-pack.tgz" | sha256sum -c - \
 && tar -xzf /tmp/wasm-pack.tgz -C /tmp \
 && install -m 755 /tmp/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack /usr/local/bin/wasm-pack \
 && rm -rf /tmp/wasm-pack* && wasm-pack --version

# ------------------------------------------------------------------ verified
# Builds the wasm from source, installs the workspace from the lockfile,
# runs every gate and both smoke tests. Nothing later trusts anything else.
FROM toolchain AS verified
WORKDIR /src
# The crate first: `occlude-core` is a link: dependency on the wasm-pack
# output, so the package must exist before `pnpm install` (README).
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cd crates/occlude-core \
 && wasm-pack build --target web --out-dir pkg --features wasm,contour-sdf --no-default-features --locked
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/occlude/package.json ./packages/occlude/
COPY packages/occlude-studio/package.json ./packages/occlude-studio/
COPY packages/occlude-docs/package.json ./packages/occlude-docs/
RUN --mount=type=cache,target=/usr/local/pnpm-store,sharing=locked \
    pnpm config set store-dir /usr/local/pnpm-store \
 && pnpm install --frozen-lockfile
COPY . .
ARG OCCLUDE_BUILD_STAMP=docker
ENV OCCLUDE_BUILD_STAMP=${OCCLUDE_BUILD_STAMP}
# `pnpm check` = the gates, one line each, ending in the smoke tests: a
# sketch through the compiled wasm to a parseable SVG, and the production
# server resolving every module and the wasm asset it serves.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    pnpm check \
 && pnpm --filter occlude-docs build

# --------------------------------------------------------------------- studio
# The serving image: the verified dist plus the plain-Node server and its
# stores. git is what the sketch store commits with. Libraries are volumes.
FROM ${NODE_IMAGE} AS studio
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=verified /src/packages/occlude-studio/dist ./dist
COPY --from=verified /src/packages/occlude-docs/dist ./dist/docs
COPY --from=verified /src/packages/occlude-studio/package.json \
                     /src/packages/occlude-studio/server.mjs \
                     /src/packages/occlude-studio/sketch-store.mjs \
                     /src/packages/occlude-studio/sketch-git.mjs \
                     /src/packages/occlude-studio/result-store.mjs \
                     /src/packages/occlude-studio/fill-store.mjs \
                     /src/packages/occlude-studio/fill-transpile.mjs \
                     /src/packages/occlude-studio/asset-store.mjs ./
COPY --from=verified /src/packages/occlude-studio/assets ./assets
# Runs as `node` (uid 1000) so files it writes into the bind-mounted
# libraries belong to the checkout's owner, not root.
RUN mkdir -p sketches fills results \
 && chown -R node:node /app \
 && git config --system --add safe.directory '*'
USER node
ENV PORT=4173 HOST=0.0.0.0
VOLUME ["/app/sketches", "/app/fills", "/app/assets", "/app/results"]
CMD ["node", "server.mjs"]

# ------------------------------------------------------------------------ dev
# The seed of the eventual containerised dev build: vite against bind-mounted
# sources, node_modules and the wasm from the verified image.
FROM verified AS dev
CMD ["pnpm", "--filter", "occlude-studio", "exec", "vite", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
