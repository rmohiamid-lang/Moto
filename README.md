# Moto — révisez vos cartes Anki

Application de révision de flashcards compatible **Anki** : importez vos paquets `.apkg`
(ou `.colpkg`) et révisez-les avec la répétition espacée, sur téléphone ou ordinateur,
**même hors ligne**. Toutes les données restent sur votre appareil.

C'est une application web installable (PWA) : une fois ouverte dans le navigateur, elle
s'installe comme une vraie application (icône sur l'écran d'accueil, plein écran, hors ligne).

## Fonctionnalités

- Import des paquets Anki `.apkg` / `.colpkg` — ancien format (`collection.anki2`, `.anki21`)
  et nouveau format compressé (`collection.anki21b`, Anki 2.1.50+)
- Images, sons (`[sound:…]`) et polices des paquets
- Rendu fidèle des modèles Anki : champs, sections `{{#…}}` / `{{^…}}`, `{{FrontSide}}`,
  textes à trous (`{{cloze:…}}`, y compris imbriqués et avec indice), `{{type:…}}` (réponse à
  saisir avec correction), `{{hint:…}}`, furigana, CSS du modèle, mode sombre
- Répétition espacée de type SM-2 (comme Anki) : boutons *À revoir / Difficile / Correct /
  Facile* avec l'intervalle suivant affiché, étapes d'apprentissage, limites quotidiennes
- La progression déjà présente dans un paquet exporté « avec planification » est conservée
- Sous-paquets (`Parent::Enfant`), renommage, suppression, annulation de la dernière réponse,
  suspension d'une carte
- Raccourcis clavier : `Espace`/`Entrée` (afficher / Correct), `1`–`4` (noter), `R` (réécouter),
  `U` (annuler), `S` (suspendre), `Échap` (retour)
- Glisser-déposer d'un fichier `.apkg` sur la page

## Installer l'application

### 1. Mettre l'application en ligne (une seule fois)

1. Le dépôt doit être **public** (GitHub Pages est payant pour les dépôts privés) :
   **Settings → General → Danger Zone → Change visibility → Public**.
2. Sur GitHub : **Settings → Pages → Build and deployment → Source : GitHub Actions**.
3. Le workflow « Déployer sur GitHub Pages » publie l'application à l'adresse
   `https://<votre-utilisateur>.github.io/Moto/`.

### 2. L'installer sur vos appareils

- **Android (Chrome)** : ouvrez l'adresse, puis menu ⋮ → *Installer l'application*
  (ou le bouton « Installer » dans l'application).
- **iPhone / iPad (Safari)** : bouton Partager → *Sur l'écran d'accueil*. Utilisez toujours
  l'icône de l'écran d'accueil : Safari peut effacer les données d'un simple site après
  7 jours sans visite, mais pas celles d'une application ajoutée à l'écran d'accueil.
- **Ordinateur (Chrome / Edge)** : icône d'installation dans la barre d'adresse.
  Une fois installée, l'application peut ouvrir directement les fichiers `.apkg`.

### Lancer en local

```sh
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

(Un serveur est nécessaire : l'ouverture directe de `index.html` en `file://` ne fonctionne pas.)

## Où trouver des paquets ?

Des milliers de paquets gratuits sont sur [AnkiWeb](https://ankiweb.net/shared/decks).
Depuis Anki : *Fichier → Exporter → Paquet de cartes Anki (.apkg)*.

## Organisation du code

| Fichier | Rôle |
| --- | --- |
| `index.html`, `styles.css` | Interface |
| `js/app.js` | Écrans (accueil, révision, réglages) |
| `js/apkg.js` | Lecture des fichiers `.apkg` (zip + SQLite + zstd + protobuf) |
| `js/template.js` | Moteur de modèles Anki (champs, cloze, saisie…) |
| `js/scheduler.js` | Algorithme de répétition espacée |
| `js/collection.js` | Import, paquets, compteurs du jour, médias |
| `js/db.js` | Stockage IndexedDB |
| `sw.js`, `manifest.webmanifest` | Mode hors ligne et installation |
| `vendor/` | [sql.js](https://github.com/sql-js/sql.js) 1.12.0, [JSZip](https://stuk.github.io/jszip/) 3.10.1, [fzstd](https://github.com/101arrowz/fzstd) 0.1.1 |

## Limites

- Pas de synchronisation avec AnkiWeb : la progression est stockée dans le navigateur de
  chaque appareil.
- Pas d'éditeur de cartes : créez-les dans Anki puis importez-les.
- Le JavaScript des modèles de cartes s'exécute dans un cadre isolé (sans accès aux données
  de l'application).
