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
