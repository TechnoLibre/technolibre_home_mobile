# Démo Owl dans un module Odoo

Ce que la plupart des gens appellent « un projet Owl » côté Odoo : du Python
pour le modèle, du JavaScript pour le composant, du XML pour son gabarit et
pour la vue qui l'accueille.

| Fichier | Rôle |
|---------|------|
| `__manifest__.py` | Déclare le module et ses assets |
| `models/demo_counter.py` | Le modèle, ses champs calculés et sa contrainte |
| `static/src/components/counter.js` | Le composant Owl |
| `static/src/components/counter.xml` | Son gabarit |
| `views/demo_views.xml` | La vue formulaire qui pose le widget |
