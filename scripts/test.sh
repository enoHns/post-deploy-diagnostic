#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
shellcheck bin/diagnostic lib/*.sh scripts/*.sh lab/vm/*.sh
node --test tests/*.test.js
