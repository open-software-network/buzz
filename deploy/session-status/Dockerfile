FROM rust:1.88-bookworm AS buzz-cli-builder

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY examples ./examples
RUN cargo build --release -p buzz-cli

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY scripts/session-status-collector.mjs /app/session-status-collector.mjs
COPY scripts/session-status-agent.mjs /app/session-status-agent.mjs
COPY --from=buzz-cli-builder /src/target/release/buzz /usr/local/bin/buzz

ENTRYPOINT ["node", "/app/session-status-collector.mjs"]
