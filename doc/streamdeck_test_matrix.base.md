<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# Stream Deck Mobile — Hardware Test Matrix

These checks must be run by hand against each physical device before a release.
There is no CI runner with hardware, so this is the safety net.

## Setup

- USB OTG cable or powered hub plugged into the device under test.
- Build install: `npm run build && npx cap sync android && cd android && ./gradlew installDebug`
- A running ERPLibre Home Mobile build with `StreamDeckPlugin` registered.

## Checklist (per physical deck)

For each of: Original v1, Mini, Original v2, MK.2, XL, XL v2 (PID 0x008f),
Plus, Neo.

- [ ] Plug deck in with app **closed**. App should launch via the USB
      ATTACHED intent-filter and show the deck in `listDecks()`.
- [ ] Plug deck in with app **open**. One dialog only, the system's "Open
      ERPLibre to handle …?"; accept it: the deck lights with its
      keys within 1 s, and the journal shows no `permission_timeout`.
- [ ] `setBrightness` 0, 50, 100 — visible difference at each level.
- [ ] `setKeyImage` with the chequerboard test pattern (red/blue, key
      index drawn on top) for every key. Visual check: every key shows
      its index in the right place.
- [ ] Press every key once — `keyChanged {pressed:true}` then
      `{pressed:false}` reported with correct key index.
- [ ] (Plus only) Rotate each dial ±5 ticks — `dialRotated` events with
      correct sign.
- [ ] (Plus only) Press each dial — `dialPressed` true/false events.
- [ ] (Plus only) Tap, long-press, and drag on LCD — `lcdTouched`
      events with type and coordinates.
- [ ] (Neo only) Tap each capacitive touch point — `neoTouched` events
      with correct index.
- [ ] `reset` clears all images.
- [ ] Unplug deck — `deckDisconnected` fires within ~500ms.
- [ ] Replug — `deckConnected` fires; `deckId` (serial) is the same as before.
- [ ] Replug with the phone **locked**, wait, unlock, accept the dialog: the
      deck lights within 1 s. Leave the dialog more than 30 s first: the
      journal names the request permission button, and accepting afterwards
      still lights the deck.
- [ ] Replug with the app in the **background**, accept the dialog: the app
      comes forward and the deck lights.
- [ ] Replug, tick "always open" in the dialog, accept; replug again: no
      dialog, the deck lights by itself.
- [ ] Replug, cancel the dialog: the plugin's own dialog follows once;
      accept it: the deck lights. Replug, cancel both: no third dialog; the
      journal names the request permission button, which lights the deck
      once granted.

<!-- [fr] -->
# Stream Deck Mobile — Matrice de tests matériels

Ces vérifications doivent être passées à la main sur chaque appareil physique
avant une publication. Aucun exécuteur d'intégration continue ne dispose du
matériel : c'est ici le filet de sécurité.

## Préparation

- Câble USB OTG ou concentrateur alimenté branché sur l'appareil testé.
- Installation de la version : `npm run build && npx cap sync android && cd android && ./gradlew installDebug`
- Une version d'ERPLibre Home Mobile en cours d'exécution avec `StreamDeckPlugin` enregistré.

## Liste de contrôle (par deck physique)

Pour chacun de : Original v1, Mini, Original v2, MK.2, XL, XL v2 (PID 0x008f),
Plus, Neo.

- [ ] Brancher le deck avec l'application **fermée**. L'application doit se
      lancer via le filtre d'intention USB ATTACHED et afficher le deck dans
      `listDecks()`.
- [ ] Brancher le deck avec l'application **ouverte**. Un seul dialogue, celui
      du système « Ouvrir ERPLibre pour gérer … ? » ; l'accepter : le
      deck s'allume avec ses touches en moins d'une seconde, et le journal ne
      montre aucun `permission_timeout`.
- [ ] `setBrightness` 0, 50, 100 — différence visible à chaque niveau.
- [ ] `setKeyImage` avec la mire en damier (rouge/bleu, index de touche dessiné
      par-dessus) sur chaque touche. Vérification visuelle : chaque touche
      affiche son index au bon endroit.
- [ ] Presser chaque touche une fois — `keyChanged {pressed:true}` puis
      `{pressed:false}` rapportés avec le bon index de touche.
- [ ] (Plus seulement) Tourner chaque molette de ±5 crans — événements
      `dialRotated` avec le bon signe.
- [ ] (Plus seulement) Presser chaque molette — événements `dialPressed`
      true/false.
- [ ] (Plus seulement) Toucher, appui long et glissement sur le LCD —
      événements `lcdTouched` avec type et coordonnées.
- [ ] (Neo seulement) Toucher chaque point capacitif — événements `neoTouched`
      avec le bon index.
- [ ] `reset` efface toutes les images.
- [ ] Débrancher le deck — `deckDisconnected` se déclenche en ~500 ms.
- [ ] Rebrancher — `deckConnected` se déclenche ; le `deckId` (numéro de série)
      est le même qu'avant.
- [ ] Rebrancher le téléphone **verrouillé**, attendre, déverrouiller, accepter
      le dialogue : le deck s'allume en moins d'une seconde. Laisser d'abord le
      dialogue plus de 30 s : le journal nomme le bouton de demande de
      permission, et accepter ensuite allume quand même le deck.
- [ ] Rebrancher l'application en **arrière-plan**, accepter le dialogue :
      l'application revient au premier plan et le deck s'allume.
- [ ] Rebrancher, cocher « toujours ouvrir » dans le dialogue, accepter ;
      rebrancher encore : aucun dialogue, le deck s'allume seul.
- [ ] Rebrancher, annuler le dialogue : le dialogue du plugin suit, une
      fois ; l'accepter : le deck s'allume. Rebrancher, annuler les deux :
      aucun troisième dialogue ; le journal nomme le bouton de demande de
      permission, qui allume le deck une fois la permission accordée.
