# Intégration GitLab et distribution

## Publier une version

1. Héberger ce dossier dans ton projet GitLab, avec Container Registry activé.
2. Configurer un runner pour les tests et un runner de publication compatible
   Docker-in-Docker avec TLS et le volume partagé `/certs/client`.
3. Protéger les tags `v*`. Créer `v1.0.1` lorsque `VERSION` vaut `1.0.1`.
4. Le pipeline teste, archive les sources et publie
  `$CI_REGISTRY_IMAGE:1.0.1` pour AMD64 et ARM64.

La construction multiarchitecture utilise Buildx ; le runner doit disposer de
workers natifs pour les deux architectures ou d'émulation configurée. Le job de
publication n'installe pas d'émulateur sur le runner.

L'image et le template ne sont pas publiés tant que ce dépôt n'est pas poussé et
le pipeline de publication exécuté. Pour un registre privé, autoriser les projets
consommateurs à tirer l'image avec leurs job tokens, ou configurer
`DOCKER_AUTH_CONFIG`. Épingler une version ou un digest.

Le fichier `examples/gitlab-consumer.yml` s'intègre à un pipeline existant. Il ne
redéfinit pas les stages ; `.post` est un stage GitLab prévu pour la fin du pipeline.
Avec `needs`, le diagnostic attend les jobs explicitement déclarés. Ajouter toutes
les dépendances nécessaires et reprendre les mêmes `rules` que le déploiement
si celui-ci est conditionnel. Le déploiement doit signaler un échec et ne pas avoir
`allow_failure: true` si le diagnostic doit attendre sa réussite.

## Composant avec paramètres (GitLab 17+)

```yaml
include:
  - component: $CI_SERVER_FQDN/platform/post-deploy-diagnostic/post-deploy@v1.0.1
    inputs:
      image: registry.gitlab.com/platform/post-deploy-diagnostic:1.0.1
      config: diagnostic.yml
      needs:
        - job: deploy_staging
          artifacts: false
      runner-tags: [staging-network]
```

Le nom de job et le stage sont personnalisables via `job-name` et `stage`.
Pour les instances sans composants, utiliser `include:project` avec le template
classique. Pour un autre GitLab sans accès au dépôt de templates, copier le job
et utiliser une image accessible à cette instance.

Les templates remettent `before_script`, `after_script`, `services` et `cache` à
vide pour éviter d'hériter de la préparation de l'application. Ils ne masquent pas
le code de sortie et conservent les artefacts avec `when: always`. Le shell de
l'image et `entrypoint: [""]` permettent au runner d'exécuter le script normalement.

Les variables et secrets injectés dans l'application déployée ne sont pas
automatiquement disponibles dans le job GitLab. Pour tester des endpoints privés,
configurer séparément l'accès du job aux variables CI/CD ou à un gestionnaire de
secrets (identité à durée courte, droits limités). Le YAML peut référencer
`${SERVICE_HOST}` et `"${SERVICE_PORT}"` sans contenir les valeurs. Un check TCP
ne requiert pas de mot de passe et ne vérifie pas l'authentification. Le runner
doit également pouvoir joindre les adresses privées depuis son réseau.

## Ajouter la commande à un job existant

Avec l'image de diagnostic :

```yaml
verify_staging:
  stage: .post
  image:
    name: registry.gitlab.com/platform/post-deploy-diagnostic:1.0.1
    entrypoint: [""]
  needs: [deploy_staging]
  script:
    - diagnostic run --config diagnostic.yml
```

Dans une autre image Linux, installer l'archive, Node.js 22+ et les outils Linux,
puis exécuter `npm ci --omit=dev --ignore-scripts` dans son dossier avant d'appeler
`bash /opt/diagnostic/bin/diagnostic run ...`. Pour un runner Shell, l'image GitLab
n'est pas utilisée : installer l'outil sur le runner. Pour Docker/Kubernetes,
utiliser directement l'image distribuée.

## Réseau Nomad

Le diagnostic observe le réseau depuis son point d'exécution. Il faut :

- un runner ayant les routes et le DNS de staging, éventuellement dans le même VPC ;
- des noms/IP et ports réellement accessibles depuis ce runner ;
- les CA internes montées si HTTPS utilise une autorité privée.

Un nom DNS Docker Compose comme `redis` est propre au réseau de la démo. Dans Nomad,
utiliser les endpoints exposés, les adresses allouées ou les noms de service de
l'environnement. Un déploiement « terminé » doit inclure l'attente de disponibilité
avant le diagnostic, ou des timeouts adaptés ; la V1 ne fait pas de retries.

Si les services sont accessibles seulement depuis le réseau d'une allocation,
exécuter l'image dans un job Nomad batch placé dans ce réseau, ou appeler le CLI
sur un hôte autorisé via SSH. La CI doit attendre sa fin et propager le code de
sortie ; le simple succès de soumission du job Nomad ne suffit pas. Les contraintes
de placement, ACL et namespaces dépendent du cluster et doivent y être configurées.

## Sources du contrat GitLab

- [Images Docker et entrypoint](https://docs.gitlab.com/ci/docker/using_docker_images/)
- [Composants CI/CD](https://docs.gitlab.com/ci/components/)
- [Syntaxe include, needs et artefacts](https://docs.gitlab.com/ci/yaml/)
- [Publication d'images](https://docs.gitlab.com/user/packages/container_registry/build_and_push_images/)
