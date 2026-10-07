#!/usr/bin/env bash
# Run ONLY in a disposable Debian/Ubuntu VM, explicitly marked as a lab.
set -euo pipefail
[[ ${EUID} == 0 && ${DIAGNOSTIC_LAB:-} == 1 ]] || { printf 'Use: sudo DIAGNOSTIC_LAB=1 bash lab/vm/bootstrap.sh (dedicated VM only)\n' >&2; exit 2; }
command -v apt-get >/dev/null || { printf 'This lab requires Debian/Ubuntu with systemd.\n' >&2; exit 2; }
[[ -d /run/systemd/system ]] || { printf 'A VM with systemd is required.\n' >&2; exit 2; }
export DEBIAN_FRONTEND=noninteractive
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
apt-get update
apt-get install -y bash curl dnsutils iproute2 iputils-ping jq netcat-openbsd openssl openssh-server \
    rsyslog tcpdump nftables dnsmasq apache2 ca-certificates xz-utils
bash "$ROOT/scripts/install-node.sh"
npm ci --prefix "$ROOT" --omit=dev --ignore-scripts --no-audit --no-fund
# Apache on 8081 leaves Nginx's ports free. These changes belong to the lab VM.
printf 'Listen 8081\n' > /etc/apache2/ports.conf
a2dissite 000-default >/dev/null
cat > /etc/apache2/sites-available/postdeploy-lab.conf <<'APACHE'
<VirtualHost *:8081>
    DocumentRoot /var/www/postdeploy-lab
    ErrorLog ${APACHE_LOG_DIR}/postdeploy-error.log
    CustomLog ${APACHE_LOG_DIR}/postdeploy-access.log combined
</VirtualHost>
APACHE
mkdir -p /var/www/postdeploy-lab
printf 'healthy\n' > /var/www/postdeploy-lab/health
a2ensite postdeploy-lab >/dev/null
systemctl restart apache2
apt-get install -y nginx
mkdir -p /etc/postdeploy-lab /var/lib/postdeploy-lab
if [[ ! -f /etc/postdeploy-lab/tls.key ]]; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj '/CN=demo.linux.test' \
        -addext 'subjectAltName=DNS:demo.linux.test,DNS:localhost,IP:127.0.0.1' \
        -keyout /etc/postdeploy-lab/tls.key -out /etc/postdeploy-lab/tls.crt
    chmod 600 /etc/postdeploy-lab/tls.key
fi
cat > /etc/nginx/sites-available/postdeploy-lab <<'NGINX'
server {
    listen 8080;
    listen 8443 ssl;
    server_name demo.linux.test localhost;
    ssl_certificate /etc/postdeploy-lab/tls.crt;
    ssl_certificate_key /etc/postdeploy-lab/tls.key;
    access_log /var/log/nginx/postdeploy-access.log;
    error_log /var/log/nginx/postdeploy-error.log;
    location = /health { return 200 "healthy\n"; }
    location = /failure { return 500 "controlled failure\n"; }
    location /apache/ { proxy_pass http://127.0.0.1:8081/; }
}
NGINX
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/postdeploy-lab /etc/nginx/sites-enabled/postdeploy-lab
nginx -t
printf 'local0.* /var/log/postdeploy-lab.log\n' > /etc/rsyslog.d/40-postdeploy-lab.conf
cat > /etc/dnsmasq.d/postdeploy-lab.conf <<'DNS'
bind-interfaces
listen-address=127.0.0.1
no-resolv
no-hosts
address=/demo.linux.test/127.0.0.1
local=/linux.test/
DNS
systemctl enable --now nginx apache2 rsyslog ssh dnsmasq
systemctl restart nginx rsyslog dnsmasq
touch /var/lib/postdeploy-lab/enabled
logger -p local0.info -t postdeploy-lab 'Linux lab provisioned'
printf '\nLab ready: nginx :8080/:8443, apache :8081, DNS 127.0.0.1:53, SSH :22.\n'
