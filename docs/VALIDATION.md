# Vérifications réalisées

Validation locale du 30 septembre 2026, sur Mac ARM64 avec OrbStack.

| Vérification | Résultat |
|---|---|
| ShellCheck | Scripts CLI, checks, packaging et laboratoires validés |
| Tests Node.js/unitaires/intégration | Migration vers `node:test` ; résultats de la nouvelle exécution dans `reports/tests.log` |
| Image Linux ARM64 | Construite et exécutée : 4/4 checks réussis |
| Image Linux AMD64 | Construite et exécutée sous émulation : 4/4 checks réussis |
| Démo Docker Compose | Succès, panne Redis, DNS/port/HTTP invalides, puis récupération validés |
| Codes de sortie | 0/1/2, checks facultatifs, timeouts et SIGTERM testés |
| Rapports | JSON et JUnit produits et analysés, y compris en échec |
| Archive distribuable | SHA-256 vérifié, extraction et exécution indépendante réussies |
| Commande GitLab | Exécutée via shell avec entrypoint remplacé dans l'image |
| VM Debian 12 avec systemd | Provisionnée ; 8/8 checks réussis |
| Pannes VM | Arrêt Nginx, arrêt DNS, blocage firewall : échec puis 8/8 après chaque réparation |
| Capture et logs | Capture TCP locale et événements rsyslog vérifiés |
| Mises à jour | Relevé des mises à jour via métadonnées locales ; aucune mise à jour disponible sur cette VM fraîche |

Les fichiers de preuve sont dans `reports/` : `tests.log`, `demo.log`,
`diagnostic.json`, `diagnostic.xml`, `vm-demo.log`, `tcpdump.txt`,
`linux-snapshot.txt`. Ils sont ignorés par Git et peuvent être régénérés.

## Laboratoires laissés disponibles sur cette machine

- Compose : projet `post-deploy-diagnostic-demo`, Nginx sur `127.0.0.1:18080`.
- VM OrbStack : `postdeploy-lab`, Debian 12, projet monté dans `/project`.

```sh
make check
orb -m postdeploy-lab -u root bash /project/lab/vm/demo.sh
```

Pour arrêter sans supprimer : `docker compose stop` et `orb stop postdeploy-lab`.
Pour supprimer les laboratoires : `make down` et `orb delete postdeploy-lab`.

## Vérifications dépendant de ton infrastructure

La publication du registre et l'exécution par un vrai runner GitLab restent à
effectuer après hébergement du dépôt. Les templates ont été analysés et leurs
contrats testés localement ; aucun pipeline GitLab distant n'a été exécuté.
Les routes/DNS/ACL Nomad se vérifient depuis le runner ou l'allocation cible.
Le bootstrap a été exécuté sur Debian 12 ; Ubuntu est documenté mais n'a pas été
testé ici, son téléchargement ayant échoué. L'authentification SSH par clé et
l'installation d'une mise à jour disponible sont des exercices guidés du labo.
