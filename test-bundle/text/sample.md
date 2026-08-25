# Document markdown de test

Ce fichier éprouve le rendu du lecteur. Chaque construction ci-dessous doit
s'afficher, et non apparaître en texte brut.

## Titres

### Niveau trois
#### Niveau quatre
##### Niveau cinq
###### Niveau six

## Tableau simple

| Méthode | Rôle | Depuis |
|---------|------|--------|
| `listDir()` | Liste un répertoire | 2026.03 |
| `readFile()` | Lit un fichier | 2026.03 |
| `getFileUrl()` | Donne l'URL d'un média | 2026.04 |

## Tableau aligné

| Gauche | Centré | Droite |
|:-------|:------:|-------:|
| a | b | c |
| aaaa | bbbb | cccc |

## Tableau large, qui doit défiler

| Colonne un | Colonne deux | Colonne trois | Colonne quatre | Colonne cinq | Colonne six |
|---|---|---|---|---|---|
| valeur assez longue | valeur assez longue | valeur assez longue | valeur assez longue | valeur assez longue | valeur assez longue |

## Listes

- premier
- deuxième
  - imbriqué
    - deux fois imbriqué
- troisième

1. un
2. deux
3. trois

## Emphase et code

Du **gras**, de l'*italique*, du `code en ligne`, et un [lien](https://erplibre.ca).

```python
def salut(qui: str) -> str:
    # un dièse ici ne doit PAS devenir un titre
    return f"salut {qui}"
```

```
un bloc sans langue
| et une barre qui ne doit pas faire un tableau |
```

> Une citation, pour vérifier le blockquote.

---

Fin du document.
