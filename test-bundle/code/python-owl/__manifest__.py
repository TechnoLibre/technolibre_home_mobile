{
    "name": "Démo Owl",
    "version": "18.0.1.0.0",
    "summary": "Un compteur Owl branché sur un modèle Odoo",
    "author": "TechnoLibre",
    "website": "https://erplibre.ca",
    "license": "AGPL-3",
    "category": "Tools",
    "depends": ["base", "web"],
    "data": ["views/demo_views.xml"],
    "assets": {
        "web.assets_backend": [
            "python_owl/static/src/components/counter.js",
            "python_owl/static/src/components/counter.xml",
        ],
    },
    "installable": True,
    "application": False,
}
