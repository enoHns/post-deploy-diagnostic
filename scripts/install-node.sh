#!/usr/bin/env bash
# Install an official Node.js 24 Linux archive, verified against its SHA-256.
set -euo pipefail
[[ $(uname -s) == Linux && ${EUID} == 0 ]] || { printf 'Run this installer as root on Linux.\n' >&2; exit 2; }
if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    node --version
    exit 0
fi
for dependency in curl sha256sum tar xz; do
    command -v "$dependency" >/dev/null || { printf 'Missing dependency: %s\n' "$dependency" >&2; exit 2; }
done
case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) printf 'Supported architectures: x86_64 and arm64\n' >&2; exit 2 ;;
esac
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
base=https://nodejs.org/dist/latest-v24.x
download() { curl --fail --silent --show-error --location --proto '=https' --connect-timeout 15 --max-time 180 --retry 2 "$@"; }
download "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
archive=$(awk -v arch="$node_arch" '$2 ~ "^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$" {print $2}' "$work/SHASUMS256.txt")
[[ "$archive" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(arm64|x64)\.tar\.xz$ ]] || { printf 'Could not identify the official Node.js archive.\n' >&2; exit 2; }
download "$base/$archive" -o "$work/$archive"
awk -v name="$archive" '$2 == name' "$work/SHASUMS256.txt" > "$work/archive.sha256"
(cd "$work" && sha256sum --check archive.sha256)
install -d /opt/postdeploy-node /usr/local/bin
tar -xJf "$work/$archive" -C /opt/postdeploy-node
for executable in node npm npx; do
    ln -sfn "/opt/postdeploy-node/${archive%.tar.xz}/bin/$executable" "/usr/local/bin/$executable"
done
node --version
