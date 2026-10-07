#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
version=$(cat VERSION)
mkdir -p dist
COPYFILE_DISABLE=1 tar --no-xattrs --exclude=node_modules -czf "dist/post-deploy-diagnostic-${version}.tar.gz" \
    VERSION bin lib templates examples docs README.md scripts tests lab \
    Makefile Dockerfile docker-compose.yml diagnostic.yml .gitlab-ci.yml .dockerignore \
    package.json package-lock.json .nvmrc
(
    cd dist
    if command -v sha256sum >/dev/null; then
        sha256sum "post-deploy-diagnostic-${version}.tar.gz" > SHA256SUMS
    else
        shasum -a 256 "post-deploy-diagnostic-${version}.tar.gz" > SHA256SUMS
    fi
)
printf 'Packaged dist/post-deploy-diagnostic-%s.tar.gz\n' "$version"
