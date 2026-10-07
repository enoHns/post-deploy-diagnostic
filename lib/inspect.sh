#!/usr/bin/env bash
# Read-only observations of the CURRENT network/host namespace.
set -uo pipefail
updates=0
if [[ ${1:-} == --updates && $# == 1 ]]; then updates=1
elif [[ $# != 0 ]]; then printf 'Usage: diagnostic inspect [--updates]\n' >&2; exit 2; fi
section() {
    printf '\n### %s\n' "$1"; shift
    if command -v "$1" >/dev/null; then
        timeout --kill-after=1s 15s "$@" 2>&1 || printf '[unavailable, nonzero status or insufficient permissions]\n'
    else printf '[command not installed: %s]\n' "$1"; fi
}
printf 'LINUX TROUBLESHOOTING SNAPSHOT\nRun on the target host for host-level observations.\n'
section 'Kernel' uname -a
section 'Operating system' cat /etc/os-release
section 'Interfaces and IP addresses' ip -brief address
section 'Routes / default gateway' ip route
section 'DNS resolver' cat /etc/resolv.conf
section 'Listening TCP and UDP sockets' ss -lntup
section 'Failed systemd services' systemctl --failed --no-pager
section 'Recent system warnings' journalctl -p warning -n 30 --no-pager
section 'nftables firewall (permissions may be required)' nft list ruleset
section 'Docker services' docker ps
if ((updates)); then
    if command -v apt >/dev/null; then section 'Available updates (local APT metadata)' apt list --upgradable
    elif command -v dnf >/dev/null; then section 'Available updates (local DNF metadata)' dnf --cacheonly check-update
    else printf '\n[No supported package manager detected]\n'; fi
fi
