# Démonstration des compétences Linux

## 1. Démo produit — Docker sur Mac, Windows ou Linux

Depuis la racine du projet, avec Docker et Compose démarrés :

```sh
make demo
```

Le script construit l'image, démarre Nginx/Redis/PostgreSQL et vérifie quatre
scénarios : tout fonctionne ; Redis arrêté ; mauvais DNS/port/HTTP 500 ; retour
à la normale. Il vérifie les codes de sortie attendus. Les services restent
disponibles pour ta présentation ; `make down` supprime ce laboratoire et ses volumes.
Les ports Redis/PostgreSQL restent internes au réseau Compose.

Exploration manuelle :

```sh
docker compose run --rm --entrypoint bash diagnostic
dig redis
nslookup postgres
nc -zv postgres 5432
curl -v http://app/health
ip -brief address
ip route
ss -nt
exit
docker compose logs app
docker compose stop redis
make check                 # code 1
docker compose start redis
make check                 # code 0
```

`ss` observe le namespace où il s'exécute. Pour les sockets Nginx, entre dans son
conteneur ou observe une VM. Un port Redis ouvert prouve l'accès TCP, pas que
l'authentification ou les requêtes Redis fonctionnent.

## 2. Démo administration — VM dédiée Debian/Ubuntu avec systemd

Utilise une VM jetable Ubuntu 24.04 avec accès sudo, par exemple dans OrbStack,
UTM, Multipass ou ton hyperviseur. Copie ce projet dans la VM puis :

```sh
sudo DIAGNOSTIC_LAB=1 bash lab/vm/bootstrap.sh
bash bin/diagnostic run --config lab/vm/diagnostic.yml
bash bin/diagnostic inspect --updates
sudo bash lab/vm/demo.sh   # vérifie automatiquement les pannes et réparations
```

Le provisionnement installe les paquets et configure les services de cette VM.
Il installe aussi Node.js 24 si nécessaire et les dépendances npm verrouillées.
Il configure Nginx sur 8080/8443, Apache sur 8081, DNS sur 127.0.0.1:53,
SSH et rsyslog. Le certificat local est autosigné, valable 30 jours et explicitement
approuvé par le check TLS via `ca_file`. Le provisionnement se relance sans
remplacer la clé existante. Pour renouveler le certificat de cette VM jetable,
supprime `/etc/postdeploy-lab/tls.key` et relance le script.

### Observer, expliquer, casser, réparer

| Compétence | Manipulation et preuve à présenter |
|---|---|
| Interfaces, sous-réseau, gateway, routes | `ip -brief address`, `ip route`, expliquer le trajet client → serveur |
| ICMP | `ping -c 3 127.0.0.1`, expliquer pourquoi un ping bloqué ne prouve pas qu'HTTP est indisponible |
| DNS | `dig @127.0.0.1 demo.linux.test A`, `nslookup demo.linux.test 127.0.0.1`, `/etc/resolv.conf` |
| TCP / sockets | `ss -lntp`, `nc -zv 127.0.0.1 8080`, observer écoute, refus et timeout |
| HTTP / reverse proxy | `curl -i http://127.0.0.1:8080/apache/health`, distinguer HTTP 500 d'un refus TCP |
| TLS | `openssl s_client -connect 127.0.0.1:8443 -servername demo.linux.test -verify_hostname demo.linux.test -CAfile /etc/postdeploy-lab/tls.crt -verify_return_error </dev/null` |
| Services | `systemctl status nginx`, `systemctl is-enabled nginx`, `journalctl -u nginx -n 30` |
| Logs / rsyslog | `logger -p local0.info -t demo 'test syslog'`, `sudo tail /var/log/postdeploy-lab.log` |
| Firewall | `sudo nft list ruleset`, panne ciblée sur 8080 puis suppression de la seule table du labo |
| Shell | lire les scripts : tableaux, quoting, pipes, `$?`, traps, timeout, `set -uo pipefail` |
| Docker | `docker compose ps`, réseau partagé, DNS des services, logs et isolation des namespaces |

Scénario de panne puis réparation :

```sh
sudo bash lab/vm/fault.sh service-down
bash bin/diagnostic run --config lab/vm/diagnostic.yml  # échec
systemctl status nginx --no-pager
sudo bash lab/vm/fault.sh recover
bash bin/diagnostic run --config lab/vm/diagnostic.yml  # succès
```

Recommence avec `dns-down` et `firewall-block`. La panne firewall ne touche
que le port 8080 ; SSH reste accessible. `recover` réactive les services et retire
la table `postdeploy_lab`.

### Capture réseau bornée

Dans un terminal de la VM :

```sh
sudo timeout 15s tcpdump -ni any -c 30 'tcp port 8080'
```

Dans un second : `curl http://127.0.0.1:8080/health`. Repère SYN, SYN-ACK, ACK
et les échanges HTTP. Recommence après la panne firewall pour comparer les RST.
La capture nécessite les permissions réseau de la VM ; le job CI ordinaire n'en a
pas besoin. Enregistre une capture avec `-w /tmp/diagnostic-demo.pcap` si utile.

### SSH

Depuis ta machine : `ssh ton-utilisateur@IP_VM`. Utilise une clé SSH et vérifie
l'empreinte du serveur à la première connexion. Compare un accès SSH fonctionnel
avec `nc -zv IP_VM 22` : l'ouverture TCP ne prouve pas l'authentification SSH.
Pour préparer une clé dédiée, si la VM autorise une première connexion par mot de passe :

```sh
ssh-keygen -t ed25519 -f ~/.ssh/linux_lab
ssh-copy-id -i ~/.ssh/linux_lab.pub ton-utilisateur@IP_VM
ssh -i ~/.ssh/linux_lab ton-utilisateur@IP_VM
```

Sinon, ajouter la clé **publique** depuis la console de la VM dans
`~/.ssh/authorized_keys` de cet utilisateur, avec les permissions 700 sur `.ssh`
et 600 sur `authorized_keys`. L'empreinte de référence se consulte dans la VM :
`sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.

Commande distante :

```sh
ssh ton-utilisateur@IP_VM 'cd /chemin/projet && bash bin/diagnostic run --config lab/vm/diagnostic.yml'
```

### Mises à jour et dépôts

Dans la VM jetable, prendre un snapshot avant de pratiquer :

```sh
cat /etc/os-release
apt-cache policy nginx
sudo apt-get update
apt list --upgradable
sudo apt-get install --only-upgrade nginx
systemctl status nginx --no-pager
bash bin/diagnostic run --config lab/vm/diagnostic.yml
cat /var/log/apt/history.log
```

Explique la différence entre actualiser l'index (`update`) et installer une
nouvelle version. S'il n'y a aucune mise à jour disponible, présente ce résultat.
Sur la famille RHEL : `dnf repolist`, `dnf check-update` (100 = mises à jour
disponibles), `dnf upgrade nginx`, `rpm -q nginx`, `dnf history`.

Le diagnostic CI ne modifie pas les paquets ni les services. Les opérations
d'administration sont explicites dans ce laboratoire.

## Présentation en 10 minutes

1. Dessiner client/runner → DNS → réseau → Nginx → application/dépendances.
2. Montrer quatre checks verts dans Compose.
3. Arrêter Redis : afficher l'échec et le code 1.
4. Dans la VM, expliquer une panne avec `ss`, `curl`, `journalctl` et `tcpdump`.
5. Réparer, relancer, puis montrer le template GitLab et les rapports.
6. Montrer l'historique d'une mise à jour et les checks après intervention.

Pour chaque panne, conserve la commande, le résultat observé, l'hypothèse, la
correction et la vérification finale. Ce sont les preuves de ton raisonnement Linux.
