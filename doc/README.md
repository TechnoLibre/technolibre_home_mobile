
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

```bash
# Depuis la racine du dépôt erplibre_mobile
./mobile/compile_and_run.sh
```

## Key identifiers

| Key | Value |
|-----|-------|
| App ID | `ca.erplibre.home` |
| App Name | `ERPLibre` |
| SQLite database | `erplibre_mobile` |
| Odoo port (dev) | 8069 |
