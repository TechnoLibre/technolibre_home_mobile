
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
