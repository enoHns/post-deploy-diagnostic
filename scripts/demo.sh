#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
compose=(docker compose)
restore() { "${compose[@]}" start redis >/dev/null 2>&1 || true; }
trap restore EXIT
expect() {
    local expected=$1 actual=0; shift
    "$@" || actual=$?
    if [[ "$actual" != "$expected" ]]; then
        printf 'Expected exit %s, received %s\n' "$expected" "$actual" >&2
        exit 1
    fi
    printf '\nVerified exit code: %s\n\n' "$actual"
}
"${compose[@]}" build diagnostic
"${compose[@]}" up -d --wait app redis postgres
printf '\n== Healthy deployment: expect 4/4 and exit 0 ==\n'
expect 0 "${compose[@]}" run --rm --no-deps diagnostic
printf '\n== Redis stopped: expect required failure and exit 1 ==\n'
"${compose[@]}" stop redis
expect 1 "${compose[@]}" run --rm --no-deps diagnostic
"${compose[@]}" start redis
printf '\n== Wrong DNS, wrong TCP port, HTTP 500: expect exit 1 ==\n'
expect 1 "${compose[@]}" run --rm --no-deps diagnostic run --config /examples/failures.yml
"${compose[@]}" up -d --wait app redis postgres
printf '\n== Recovered deployment: expect exit 0 ==\n'
expect 0 "${compose[@]}" run --rm --no-deps diagnostic
printf '\nDemo finished. Services remain available on localhost:18080.\nClean up: docker compose down --volumes\n'
