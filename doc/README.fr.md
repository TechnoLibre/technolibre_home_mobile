
# ERPLibre Home Mobile — Documentation

Application mobile ERPLibre construite avec **Odoo Owl + Capacitor**.

## Table des matières

| Fichier | Description |
|---------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Stack technique, vue d'ensemble du projet |
| [COMPONENTS.md](./COMPONENTS.md) | Hiérarchie et rôle de chaque composant |
| [SERVICES.md](./SERVICES.md) | Couche service et logique métier |
| [DATA_MODELS.md](./DATA_MODELS.md) | Modèles de données et schéma SQLite |
| [ROUTING.md](./ROUTING.md) | Système de routage |
| [EVENTS.md](./EVENTS.md) | Bus d'événements inter-composants |
| [BUILD.md](./BUILD.md) | Compilation, déploiement, environnements |
| [NATIVE_PLUGINS.md](./NATIVE_PLUGINS.md) | Plugins Capacitor maison (Java) |
| [I18N.md](./I18N.md) | Système de traduction et ajout d'une langue |
| [BUNDLE_PIPELINE.md](./BUNDLE_PIPELINE.md) | Bundles tar.gz, extraction paresseuse, mode édition |
| [SECURITY_PLAN.md](./SECURITY_PLAN.md) | Audit de sécurité et plan de correction |
| [DEBUG_MENU.md](./DEBUG_MENU.md) | Le menu ⋮ et sa surcouche de débogage |
| [streamdeck_test_matrix.md](./streamdeck_test_matrix.md) | Tests matériels manuels du Stream Deck |
| [bundle_extract_test_matrix.md](./bundle_extract_test_matrix.md) | Tests manuels d'extraction et d'édition de bundle |

## Démarrage rapide

```bash
# Depuis la racine du dépôt erplibre_mobile
./mobile/compile_and_run.sh
```

## Identifiants clés

| Clé | Valeur |
|-----|--------|
| App ID | `ca.erplibre.home` |
| App Name | `ERPLibre` |
| Base de données SQLite | `erplibre_mobile` |
| Port Odoo (dev) | 8069 |