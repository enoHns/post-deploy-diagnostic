#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
[[ ${EUID} == 0 && -f /var/lib/postdeploy-lab/enabled ]] || { printf 'Run as root inside the provisioned lab VM.\n' >&2; exit 2; }
trap 'bash lab/vm/fault.sh recover' EXIT
expect() {
    local expected=$1 actual=0
    bash bin/diagnostic run --config lab/vm/diagnostic.yml || actual=$?
    [[ "$actual" == "$expected" ]] || { printf 'Expected exit %s, received %s\n' "$expected" "$actual" >&2; exit 1; }
}
expect 0
for scenario in service-down dns-down firewall-block; do
    printf '\n== %s ==\n' "$scenario"
    bash lab/vm/fault.sh "$scenario"
    expect 1
    bash lab/vm/fault.sh recover
    expect 0
done
printf '\nAll VM fault and recovery scenarios passed.\n'
