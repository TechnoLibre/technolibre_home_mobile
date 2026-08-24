<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# ERPLibre Home Mobile — Documentation

ERPLibre mobile application built with **Odoo Owl + Capacitor**.

## Table of contents

| File | Description |
|------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Technical stack, project overview |
| [COMPONENTS.md](./COMPONENTS.md) | Hierarchy and role of each component |
| [SERVICES.md](./SERVICES.md) | Service layer and business logic |
| [DATA_MODELS.md](./DATA_MODELS.md) | Data models and SQLite schema |
| [ROUTING.md](./ROUTING.md) | Routing system |
| [EVENTS.md](./EVENTS.md) | Inter-component event bus |
| [BUILD.md](./BUILD.md) | Build, deployment, environments |
| [NATIVE_PLUGINS.md](./NATIVE_PLUGINS.md) | Custom Capacitor plugins (Java) |
| [I18N.md](./I18N.md) | Translation system and how to add a language |
| [BUNDLE_PIPELINE.md](./BUNDLE_PIPELINE.md) | tar.gz bundles, lazy extraction, edit mode |
| [SECURITY_PLAN.md](./SECURITY_PLAN.md) | Security audit and remediation plan |
| [DEBUG_MENU.md](./DEBUG_MENU.md) | The ⋮ menu and its debug overlay |
| [streamdeck_test_matrix.md](./streamdeck_test_matrix.md) | Manual Stream Deck hardware tests |
| [bundle_extract_test_matrix.md](./bundle_extract_test_matrix.md) | Manual bundle extraction and edit tests |

## Quick start

<!-- [fr] -->
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

<!-- [common] -->
```bash
# Depuis la racine du dépôt erplibre_mobile
./mobile/compile_and_run.sh
```

<!-- [en] -->
## Key identifiers

| Key | Value |
|-----|-------|
| App ID | `ca.erplibre.home` |
| App Name | `ERPLibre` |
| SQLite database | `erplibre_mobile` |
| Odoo port (dev) | 8069 |

<!-- [fr] -->
## Identifiants clés

| Clé | Valeur |
|-----|--------|
| App ID | `ca.erplibre.home` |
| App Name | `ERPLibre` |
| Base de données SQLite | `erplibre_mobile` |
| Port Odoo (dev) | 8069 |
