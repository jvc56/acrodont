# syntax=docker/dockerfile:1.7
# Two images from one build (PLAN.md § Repository layout):
#   --target ops      the backend's tools for scheduled and operator tasks:
#                     Postgres 16 (server and client), python3 + boto3, and
#                     scripts/backup.py, restore.py, drill.py and
#                     acrodont-master-psql. Never serves traffic.
#   --target backend  (the default, last) the server alone on debian-slim.
# Base images are pinned by digest, so a moved or vanished tag cannot change a
# build (birdtest's nightly died for weeks on a deleted image). To update one:
#   docker pull <image:tag> && docker image inspect --format '{{index .RepoDigests 0}}' <image:tag>

FROM rust:1.98-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS build
# Uncapped, cargo and the AWS SDK's release build froze a 16 GB machine
# (birdtest). CI raises it.
ARG CARGO_BUILD_JOBS=2
ENV SQLX_OFFLINE=true CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
WORKDIR /src/backend
COPY backend/ ./
# COPY keeps the checkout's modification times, and the target cache mount
# outlives the build: a checkout older than the cached build looked "fresh" to
# cargo and the image shipped another checkout's binary. Touch first (MIG-2).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/backend/target \
    find src migrations build.rs Cargo.toml Cargo.lock -type f -exec touch {} + \
    && cargo build --release --locked --bin acrodont \
    && cp target/release/acrodont /usr/local/bin/acrodont

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS ops
# pg_dump must be at least the server's version, and bookworm ships 15, hence PGDG.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 python3-boto3 \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSo /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16 \
    && apt-get purge -y gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/lib/postgresql/16/bin:$PATH
COPY scripts/backup.py scripts/restore.py scripts/drill.py scripts/ops_master_psql.py /opt/acrodont/scripts/
RUN ln -s /opt/acrodont/scripts/ops_master_psql.py /usr/local/bin/acrodont-master-psql \
    && chmod 0755 /opt/acrodont/scripts/*.py

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS backend
# curl for the container health check; nothing else.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/acrodont /usr/local/bin/acrodont
USER nobody
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/acrodont"]
