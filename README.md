# Moto — révisez vos cartes Anki

Application de révision de flashcards compatible **Anki** : importez vos paquets `.apkg`
(ou `.colpkg`) et révisez-les avec la répétition espacée, sur téléphone ou ordinateur,
**même hors ligne**. Toutes les données restent sur votre appareil.

C'est une application web installable (PWA) : une fois ouverte dans le navigateur, elle
s'installe comme une vraie application (icône sur l'écran d'accueil, plein écran, hors ligne).

## Fonctionnalités

- **Import** des paquets Anki `.apkg` / `.colpkg` — ancien format (`collection.anki2`, `.anki21`)
  et nouveau format compressé (`collection.anki21b`, Anki 2.1.50+), avec images, sons et polices
- **Rendu fidèle** des modèles Anki : champs, sections `{{#…}}` / `{{^…}}`, `{{FrontSide}}`,
  textes à trous (y compris imbriqués et avec indice), réponse à taper avec correction,
  `{{hint:…}}`, furigana, CSS du modèle, mode sombre
- **Répétition espacée** au choix : **FSRS** (l'algorithme des versions récentes d'Anki, avec
  rétention visée réglable) ou SM-2 ; étapes d'apprentissage ; la progression d'un paquet exporté
  « avec planification » est conservée
- **Limites par paquet** (nouvelles cartes et révisions par jour), appliquées aussi aux parents
- **Révision personnalisée** : nouvelles cartes en plus, limite de révisions augmentée, cartes
  oubliées aujourd'hui, révision en avance, étude d'un tag
- **Créer et modifier des cartes** : Basique, Basique et inversée, Réponse à taper, Texte à trous
  (bouton « Trou »), gras/italique/souligné, images et photos (réduites automatiquement)
- **Parcourir** toutes les cartes : recherche (`tag:`, `deck:`, `is:new|learn|review|due|suspended`,
  `-mot` pour exclure), filtres, et actions groupées (suspendre, réactiver, déplacer,
  réinitialiser, supprimer)
- **Statistiques** : révisions du jour, série de jours 🔥, taux de réussite sur 30 jours,
  calendrier d'activité, prévision des révisions sur 30 jours, répartition des cartes
- **Gestes tactiles** : toucher la carte pour la réponse, glisser à gauche « À revoir », à droite
  « Correct »
- **Lecture à voix haute** avec la voix de l'appareil (automatique ou bouton 🔊), langue réglable
  par paquet ; les balises `{{tts …}}` des paquets Anki sont reconnues
- **Rappels** sans serveur : rappel quotidien ajouté au Calendrier de l'appareil (fichier `.ics`)
  et badge sur l'icône avec le nombre de cartes à revoir
- **Hors ligne** : l'application démarre instantanément depuis le cache ; les mises à jour se
  téléchargent en arrière-plan et s'appliquent à l'ouverture suivante
- Raccourcis clavier : `Espace`/`Entrée` (afficher / Correct), `1`–`4` (noter), `R` (réécouter),
  `T` (lire à voix haute), `E` (modifier), `U` (annuler), `S` (suspendre), `Échap` (retour)

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
| `js/app.js` | Accueil, import, réglages, options de paquet, révision personnalisée |
| `js/study.js` | Écran de révision (gestes, voix, annulation) |
| `js/editor.js` | Création et modification des notes |
| `js/browse.js` | Navigateur de cartes |
| `js/stats.js` | Statistiques |
| `js/reminders.js` | Rappel Calendrier et badge |
| `js/tts.js` | Lecture à voix haute |
| `js/state.js`, `js/ui.js` | État partagé, limites quotidiennes, utilitaires d'interface |
| `js/apkg.js` | Lecture des fichiers `.apkg` (zip + SQLite + zstd + protobuf) |
| `js/template.js` | Moteur de modèles Anki (champs, cloze, saisie…) |
| `js/scheduler.js` | Algorithmes de répétition espacée (FSRS-5 et SM-2) |
| `js/collection.js` | Import, paquets, compteurs du jour, médias |
| `js/db.js` | Stockage IndexedDB |
| `sw.js`, `manifest.webmanifest` | Mode hors ligne et installation |
| `vendor/` (licences dans `vendor/THIRD_PARTY_LICENSES.txt`) | [sql.js](https://github.com/sql-js/sql.js) 1.12.0, [JSZip](https://stuk.github.io/jszip/) 3.10.1, [fzstd](https://github.com/101arrowz/fzstd) 0.1.1 |

## Limites

- Pas de synchronisation avec AnkiWeb : la progression est stockée dans le navigateur de
  chaque appareil.
- Pas de vraies notifications « push » (elles demandent un serveur) : le rappel passe par le
  Calendrier de l'appareil.
- Le JavaScript des modèles de cartes s'exécute dans un cadre isolé (sans accès aux données
  de l'application).
