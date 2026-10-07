# Post-Deployment Network & Service Diagnostic

Un outil **Linux en Bash**, distribué en image Docker et en archive, pour vérifier
un déploiement depuis un job GitLab. Il exécute de vraies commandes Linux :
`dig`, `nc`, `curl`, `openssl`, `ping`, `systemctl`.

**Contrat :** YAML explicite → checks avec timeouts → rapport humain, JSON et
JUnit → code de sortie utilisable par la CI. Aucun service n'est autodétecté.

## Essayer en local

Prérequis : Docker démarré, Docker Compose v2 et Bash. Fonctionne sur Mac,
Windows avec WSL, et Linux.

```sh
make demo
```

La démo construit l'image, lance Nginx/Redis/PostgreSQL, vérifie **4/4 checks**,
arrête Redis pour montrer un échec, teste DNS invalide/port erroné/HTTP 500,
puis vérifie le rétablissement. Nettoyage : `make down`.

Pour lancer manuellement :

```sh
make build
make up
make check
```

## Vérifier son application

Créer `diagnostic.yml` :

```yaml
service:
  name: my-api
  environment: staging
global:
  timeout: 30s
checks:
  - name: redis
    type: tcp
    host: redis.staging.internal
    port: 6379
    required: true
    timeout: 5s
  - name: application
    type: http
    url: https://api.staging.example/health
    expected_status: 200
```

```sh
docker run --rm \
  -v "$PWD/diagnostic.yml:/config/diagnostic.yml:ro" \
  post-deploy-diagnostic:1.0.1 run --config /config/diagnostic.yml
```

Le conteneur doit avoir les routes et le DNS des cibles. `localhost` désigne le
conteneur de diagnostic. Pour la démo, `docker compose run` rejoint le réseau
des services automatiquement.

| Code | Signification |
|---|---|
| `0` | Tous les checks obligatoires passent ; les échecs facultatifs restent visibles |
| `1` | Au moins un check obligatoire échoue |
| `2` | Configuration invalide, outil indisponible, erreur de rapport ou interruption |

## Intégration GitLab après déploiement

Après publication de l'image et du dépôt de templates :

```yaml
include:
  - project: platform/post-deploy-diagnostic
    ref: v1.0.1
    file: /templates/diagnostic.yml

post_deploy_diagnostic:
  extends: .post-deploy-diagnostic
  stage: .post
  needs:
    - job: deploy_staging
      artifacts: false
  variables:
    DIAGNOSTIC_IMAGE: registry.gitlab.com/platform/post-deploy-diagnostic:1.0.1
    DIAGNOSTIC_CONFIG: diagnostic.yml
```

Remplacer les chemins et le nom du job de déploiement. Le template conserve les
rapports même en cas d'échec et renseigne l'onglet **Tests** de GitLab.

Utilisation directe dans un job existant :

```sh
diagnostic run --config diagnostic.yml \
  --json-report reports/diagnostic.json --junit-report reports/diagnostic.xml
```

## Développer et distribuer

```sh
make test      # ShellCheck + tests locaux DNS/TCP/HTTP/TLS, timeouts et rapports
make build     # image pour l'architecture locale
```

Le pipeline fourni teste le projet, produit une archive et publie une image
`linux/amd64` + `linux/arm64` pour les tags protégés `vX.Y.Z`, cohérents avec
`VERSION`. La publication nécessite un runner Docker-in-Docker configuré.
Les pipelines consommateurs utilisent simplement l'image publiée.

Sur Linux avec les dépendances installées : `bash bin/diagnostic run --config diagnostic.yml`.
`make package` produit l'archive et son SHA-256. Node.js traite la configuration
YAML et les rapports ; le réseau est testé en Bash. L'image embarque Node.js 24
et la dépendance `yaml`, verrouillée dans `package-lock.json`.

Pour développer sur Linux avec Node.js 22+ (24 conseillé) et les outils installés :

```sh
npm ci --ignore-scripts
npm test
```

## Documentation

- [Configuration et commandes](docs/CONFIGURATION.md)
- [GitLab, distribution et réseau Nomad](docs/GITLAB.md)
- [Laboratoire Linux et scénario de présentation](docs/LAB.md)
- [Résultats des vérifications](docs/VALIDATION.md)

Les manipulations d'administration sont pratiquées dans une VM dédiée.
