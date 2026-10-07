#!/usr/bin/env bash
# All mutations are restricted to the named lab services/table.
set -euo pipefail
[[ ${EUID} == 0 && -f /var/lib/postdeploy-lab/enabled ]] || { printf 'Run as root inside the provisioned lab VM.\n' >&2; exit 2; }
case "${1:-}" in
    service-down) systemctl stop nginx ;;
    dns-down) systemctl stop dnsmasq ;;
    firewall-block)
        if nft list table inet postdeploy_lab >/dev/null 2>&1; then nft delete table inet postdeploy_lab; fi
        nft -f - <<'NFT'
table inet postdeploy_lab {
  chain input {
    type filter hook input priority 0; policy accept;
    tcp dport 8080 reject with tcp reset
  }
}
NFT
        ;;
    recover)
        if nft list table inet postdeploy_lab >/dev/null 2>&1; then nft delete table inet postdeploy_lab; fi
        systemctl start nginx dnsmasq
        ;;
    *) printf 'Usage: fault.sh service-down|dns-down|firewall-block|recover\n' >&2; exit 2 ;;
esac
logger -p local0.warning -t postdeploy-lab "Lab scenario: $1"
