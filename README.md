# Maquette de présentation — portfolio Accélérateur M

Portfolio des entreprises accompagnées par l'Accélérateur M depuis 2014,
préparé pour une présentation à la Métropole Aix-Marseille-Provence.

## Pourquoi le contenu est chiffré

GitHub Pages impose un dépôt public sur le plan gratuit. Les données ne
partent donc **que chiffrées** (`donnees.enc.json`, AES-256-GCM, clé dérivée
par PBKDF2-SHA256 à 250 000 itérations).

Le déchiffrement a lieu dans le navigateur du lecteur, après saisie de la
phrase de passe. Rien n'est transmis à un serveur, et le dépôt ne contient à
aucun moment les données en clair — `data-seed.js` est ignoré par git.

Ce choix n'est pas cosmétique : la maquette nomme 180 entreprises, indique
lesquelles ont cessé leur activité et les montants qu'elles ont levés. Ces
informations n'ont pas à être indexables publiquement.

## Régénérer les données

Après toute modification de `data-seed.js` :

```sh
MAQUETTE_PASSPHRASE='...' node chiffre.js
git add donnees.enc.json && git commit -m "Données mises à jour" && git push
```

## Contenu

| Fichier | Rôle |
|---|---|
| `index.html` | Page d'entrée et porte de saisie |
| `portail.js` | Déchiffrement et démarrage de l'application |
| `app.js` | L'application (portfolio, promotions, carte, statistiques) |
| `donnees.enc.json` | Les 180 fiches, chiffrées |
| `chiffre.js` | Outil de chiffrement, à lancer en local |
| `fonts/` | D-DIN PRO, licence SIL OFL 1.1 |

`LISEZ-MOI.txt` détaille la provenance de chaque donnée affichée et les
points de vigilance avant diffusion.
