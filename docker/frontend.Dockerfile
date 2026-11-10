# syntax=docker/dockerfile:1.7
# Nginx serving the SvelteKit static build and proxying /api to the backend.
# Pinned by digest, as in backend.Dockerfile.
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
COPY contract-fixtures/ /src/contract-fixtures/
# The monotonic build number and git hash (PLAN.md § API → POST /api/sync).
ARG APP_BUILD=0
ARG APP_COMMIT=dev
# Lowered storage limits for the end-to-end budget journeys only; empty in a release.
ARG TEST_LIMITS=""
ENV ACRODONT_BUILD=$APP_BUILD ACRODONT_COMMIT=$APP_COMMIT ACRODONT_TEST_LIMITS=$TEST_LIMITS
RUN npm run build

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/acrodont-headers.inc /etc/nginx/conf.d/acrodont-headers.inc
COPY --from=build /src/frontend/build /usr/share/nginx/html
ENV BACKEND_UPSTREAM=backend:8080 \
    REAL_IP_FROM=127.0.0.1 \
    HSTS=""
