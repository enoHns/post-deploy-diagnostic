#!/usr/bin/env bash
# Runs inside a GNU timeout process group. Never eval configuration values.
set -uo pipefail
umask 077
config=$1 index=$2 work=$3
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
check=$(jq -c --argjson i "$index" '.checks[$i]' "$config") || exit 2
get() { jq -r "$1 // empty" <<< "$check"; }
kind=$(get '.type')
host=$(get '.host')
port=$(get '.port')
limit=$(get '.timeout_ms')
seconds=$(( (limit + 999) / 1000 ))
status=passed code='' error='' detail='' hints='[]'
failed() { status=failed; code=$1; error=$2; hints=$3; }

case "$kind" in
    dns)
        server=$(get '.server') record=$(get '.record')
        args=(-r +search +time="$seconds" +tries=1 +noall +answer)
        [[ -z "$server" ]] || args+=("@$server")
        if dig "${args[@]}" "$host" "$record" > "$work/dns.out" 2>/dev/null; then
            addresses=$(awk -v record="$record" '$4 == record { print $5 }' "$work/dns.out" | sort -u | paste -sd, -)
            if [[ -n "$addresses" ]]; then detail="Resolved $record: $addresses"
            else failed DNS_ERROR 'No matching DNS records returned' '["Check hostname, DNS zone, search domains and service registration"]'; fi
        else failed DNS_ERROR 'DNS query failed' '["Check DNS server reachability and resolver configuration"]'; fi ;;
    tcp)
        if nc -z -v -w "$seconds" "$host" "$port" > /dev/null 2> "$work/network.err"; then
            detail='TCP connection established'
        elif grep -qi 'refused' "$work/network.err"; then
            failed CONNECTION_REFUSED 'Connection refused' '["Check that the service is running and listening on this port","Check the port and firewall rules"]'
        else failed TCP_ERROR 'TCP connection failed' '["Check DNS resolution, route, port and firewall rules","Check service availability and listening interfaces"]'; fi ;;
    http)
        node "$ROOT/lib/data.js" curl-config "$config" "$index" "$work/curl.conf" || exit 2
        method=$(get '.method') expected=$(get '.expected_status')
        args=(--disable --globoff --silent --show-error --noproxy '*' --proto '=http,https' --output /dev/null
              --write-out '%{http_code}' --connect-timeout "$seconds" --max-time "$seconds" --config "$work/curl.conf")
        [[ "$method" != HEAD ]] || args+=(--head)
        http_code=$(curl "${args[@]}" 2> "$work/network.err"); rc=$?
        if ((rc == 0)); then
            detail="HTTP $http_code (expected $expected)"
            [[ "$http_code" == "$expected" ]] || failed HTTP_STATUS "Expected HTTP $expected, received $http_code" '["Check health endpoint, application and reverse proxy logs"]'
        else
            case "$rc" in
                5|6) failed DNS_ERROR 'HTTP hostname resolution failed' '["Check resolver configuration and hostname"]' ;;
                7) failed CONNECTION_FAILED 'HTTP TCP connection failed' '["Check listening port, routing and firewall"]' ;;
                28) failed CHECK_TIMEOUT 'HTTP request timed out' '["Check service availability, network and response time"]' ;;
                35|51|58|60|77|83|90|91) failed TLS_ERROR 'TLS handshake or certificate verification failed' '["Check certificate hostname, expiry and trust chain","Use CURL_CA_BUNDLE for a private CA"]' ;;
                2|3|4|23|26|27|43|48) status=error; code=CURL_ERROR; error='curl could not execute the request' ;;
                *) failed HTTP_ERROR 'HTTP exchange failed' '["Check protocol, server and reverse proxy logs"]' ;;
            esac
        fi ;;
    tls)
        server_name=$(get '.server_name') target=$(get '.target') ca_file=$(get '.ca_file')
        args=(s_client -connect "$target" -servername "$server_name" -verify_return_error -brief)
        if [[ "$server_name" == *:* || "$server_name" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            args+=(-verify_ip "$server_name")
        else args+=(-verify_hostname "$server_name"); fi
        [[ -z "$ca_file" ]] || args+=(-CAfile "$ca_file")
        if openssl "${args[@]}" < /dev/null > "$work/tls.out" 2>&1; then
            detail='TLS handshake and certificate verification passed'
        else failed TLS_ERROR 'TLS handshake or certificate verification failed' '["Check hostname, port, expiry and certificate trust chain","Check connectivity with a TCP check"]'; fi ;;
    ping)
        if ping -n -c 1 -W "$seconds" "$host" > /dev/null 2> "$work/network.err"; then detail='ICMP echo reply received'
        elif grep -qiE 'not permitted|permission' "$work/network.err"; then status=error; code=PERMISSION; error='ICMP permission unavailable; check ping socket permissions or CAP_NET_RAW'
        else failed ICMP_ERROR 'No ICMP echo reply' '["ICMP may be filtered even when TCP/HTTP works","Check the host, routes and firewall"]'; fi ;;
    service)
        if [[ ! -d /run/systemd/system ]]; then status=error; code=SYSTEMD_UNAVAILABLE; error='Run service checks on the Linux host with systemd'
        elif systemctl is-active --quiet -- "$(get '.unit')"; then detail='systemd unit is active'
        else failed SERVICE_INACTIVE 'systemd unit is not active' '["Use systemctl status and journalctl -u on the target host"]'; fi ;;
    *) exit 2 ;;
esac
jq -n --arg status "$status" --arg code "$code" --arg error "$error" --arg detail "$detail" --argjson hints "$hints" \
    '{status:$status} + (if $code != "" then {error_code:$code,error:$error,hints:$hints} else {detail:$detail} end)'
