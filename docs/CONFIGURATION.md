# Configuration et commandes

## Commandes

```sh
diagnostic version
diagnostic validate --config diagnostic.yml
diagnostic run --config diagnostic.yml
diagnostic run --config diagnostic.yml --format json
diagnostic run --config diagnostic.yml --timeout 60s \
  --json-report reports/diagnostic.json --junit-report reports/diagnostic.xml
diagnostic inspect
diagnostic inspect --updates
```

`inspect` affiche les interfaces, routes, résolveur, sockets, services, logs et
firewall du **contexte courant**. Une information inaccessible est indiquée comme
telle. Ce relevé interactif ne sert pas de verdict CI. `--updates` utilise les
métadonnées locales des paquets et n'effectue aucune installation.

## Champs communs

| Champ | Valeur / défaut |
|---|---|
| `service.name` | Nom obligatoire |
| `service.environment` | Libellé facultatif |
| `global.timeout` | `30s` ; budget cumulé des checks, exécutés dans l'ordre |
| `checks[].name` | Nom unique obligatoire |
| `checks[].type` | `dns`, `tcp`, `http`, `tls`, `ping`, `service` |
| `checks[].required` | `true` ; `false` conserve l'échec sans faire échouer le job |
| `checks[].timeout` | `5s` |

Durées : `500ms`, `1.5s`, `2m`, `1h`, entre 1 ms et 24 h. `--timeout` remplace le
budget global. Le délai le plus court s'applique. À expiration globale, les checks
restants sont déclarés en échec. L'arrêt des processus et la production des
rapports ajoutent un léger délai, dont une grâce de terminaison de 200 ms.

Les champs inconnus, clés dupliquées, alias YAML, documents multiples, mauvais
types et variables absentes sont rejetés. Maximum : 1 MiB et 1024 checks.
La validation a lieu avant tout check réseau. Utiliser les booléens YAML 1.2
`true`/`false` et ne pas utiliser `null` pour un champ.

`${VARIABLE}` est accepté dans les libellés du service, hôtes, URL, headers et
chemins de certificats. Les ports TCP/TLS acceptent aussi `"${VARIABLE}"` si la
variable contient un entier de 1 à 65535. L'expansion se fait après analyse du
YAML, sans exécution shell. Les booléens et durées sont des valeurs littérales.

## Types de checks

```yaml
service: {name: example}
checks:
  - name: dns
    type: dns
    host: app.internal
    record: A                 # A (défaut) ou AAAA
    # server: 10.0.0.53       # résolveur explicite facultatif
  - name: tcp
    type: tcp
    host: app.internal
    port: 8080
  - name: http
    type: http
    url: https://app.internal/health
    method: GET               # GET (défaut) ou HEAD
    expected_status: 200
    headers:
      Authorization: Bearer ${HEALTH_TOKEN}
  - name: tls
    type: tls
    host: app.internal
    port: 443                 # défaut 443
    server_name: app.internal # défaut host, utilisé pour SNI et vérification
    # ca_file: /certs/internal-ca.pem
  - name: icmp
    type: ping
    host: app.internal
    required: false
  - name: nginx
    type: service
    unit: nginx.service       # nécessite systemd sur l'hôte d'exécution
```

- **DNS** : `dig`, requête A/AAAA, suit les domaines de recherche du résolveur.
  `/etc/hosts` n'est pas interrogé par ce check ; les connexions TCP/HTTP utilisent
  la résolution système. Une réponse DNS vide est un échec, même si `dig` sort à 0.
- **TCP** : `nc -z`, ouvre une connexion puis la ferme. Aucun protocole Redis,
  PostgreSQL ou SSH n'est exécuté. L'hôte et le port peuvent venir de l'environnement
  du job avec `host: "${SERVICE_HOST}"` et `port: "${SERVICE_PORT}"`. Ce check ne
  valide ni l'authentification ni le bon fonctionnement du protocole applicatif.
- **HTTP** : `curl`, statut exact, vérification TLS active, redirections non suivies,
  aucun retry. Le corps est rejeté ; son transfert reste borné par les timeouts.
  Connexions directes, variables proxy et `.curlrc` ignorées pour tester le réseau
  de l'application. `CURL_CA_BUNDLE` permet une autorité interne pour HTTPS.
- **TLS** : `openssl s_client`, handshake et vérification du certificat, du nom
  (ou IP), de la période de validité et de la chaîne de confiance.
- **Ping** : un écho ICMP ; les permissions ping/CAP_NET_RAW peuvent être nécessaires.
- **Service** : `systemctl is-active`, à lancer sur une VM/hôte Linux avec systemd.
  Une image Docker ordinaire n'inspecte pas les services du serveur distant.

## Rapports et secrets

Les rapports comprennent le nom, type, cible, caractère obligatoire, durée, statut,
code d'erreur et pistes de vérification. Les pistes sont des hypothèses ; elles ne
prétendent pas identifier automatiquement la cause applicative.

Les headers, valeurs de requête HTTP et sorties brutes de curl/openssl ne sont pas
publiés. Les URL avec identifiants sont refusées. Les noms, hôtes et chemins URL
restent visibles : ne pas y placer de secret. Les fichiers temporaires ont des
permissions privées et sont supprimés à la sortie. Ne pas lancer avec `bash -x`.

En JUnit : échec obligatoire → `failure`, échec facultatif → `skipped`, erreur
d'outillage → `error`. Le JSON conserve chaque échec facultatif en `failed`.
Une erreur de configuration préalable ne produit pas de rapport de checks.

Pour enregistrer les rapports sur ta machine avec Docker :

```sh
mkdir -p reports
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work post-deploy-diagnostic:1.0.1 \
  run --config diagnostic.yml --json-report reports/diagnostic.json \
  --junit-report reports/diagnostic.xml
```

Adapter le réseau Docker aux endpoints. L'option `--user` permet d'écrire dans le
dossier monté avec les droits de ton utilisateur. Dans GitLab, le dossier de travail
doit être accessible à l'utilisateur de l'image (UID 10001).

## Exécution Linux sans Docker

Sur Debian/Ubuntu, depuis le dossier extrait de l'archive :

```sh
sudo apt-get update
sudo apt-get install bash coreutils curl dnsutils iproute2 iputils-ping jq \
  netcat-openbsd openssl ca-certificates xz-utils
sudo bash scripts/install-node.sh  # installe Node.js 24 si Node.js 22+ est absent
npm ci --omit=dev --ignore-scripts
bash bin/diagnostic validate --config diagnostic.yml
```

Sur la famille RHEL, utiliser les équivalents `bind-utils`, `iproute`, `iputils`,
`nmap-ncat`, et installer Node.js 22+ avec npm. Cette distribution n'est pas la cible du laboratoire
automatisé. `inspect` utilise en complément `openssh-client`, `tcpdump`, `nft`,
`journalctl` et le client Docker lorsque présents.

L'installeur utilise une archive officielle de Node.js 24 et vérifie son SHA-256
avant extraction dans `/opt/postdeploy-node`. Un Node.js 22+ déjà installé est
conservé. Pour les tests natifs, installer aussi `shellcheck` et `libxml2-utils`.
L'image Docker contient déjà toutes les dépendances d'exécution.

Références : [versions Node.js](https://nodejs.org/en/about/previous-releases),
[parseur YAML](https://eemeli.org/yaml/).
