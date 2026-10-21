
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
- [ ] Rebrancher l'application au premier plan, annuler le dialogue : aucun
      second dialogue, à ce retour ni aux suivants ; en 1 s environ le journal
      nomme le bouton de demande de permission, qui affiche un dialogue et
      allume le deck une fois la permission accordée.
- [ ] Écran partagé, l'application dans un volet : rebrancher, puis toucher
      le volet de l'application pendant que le dialogue s'affiche dans
      l'autre : aucune ligne au journal avant 30 s ; accepter le dialogue :
      le deck s'allume.