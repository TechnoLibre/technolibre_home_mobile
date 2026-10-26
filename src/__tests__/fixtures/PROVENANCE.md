# Composer goldens: provenance

`composer-golden.json` is **executed**, not derived: Odoo 18's own
`prettifyMessageContent` (`@mail/utils/common/format`) produced every body,
in headless Chromium, on a page of `/odoo/discuss`. The mentions of each
case went through the `mail.store` service's `getMentionsFromText` first, as
the browser does before it posts, which gives `partnerIds` and
`specialMentions`.

- Input: `composer-cases.json` (invented names only).
- Script: `long_test/mobile_sync_composer.py` of the ERPLibre repository.
- Odoo: `odoo18.0/odoo` at commit `abbc2026adb79a8932019020d62fb9316dac5817`.
- Server: a disposable Odoo 18 of the long tests, kept by
  `./long_test/mobile_sync.py --versions 18 --garder`, removed afterwards by
  `./long_test/mobile_sync.py --detruire`.

Command, from the ERPLibre repository root (URL and base as printed by the
kept run):

```bash
./long_test/mobile_sync_composer.py <url> admin admin --base <base>
```

The function runs client-side: any Odoo 18 of the checkout at that commit
gives the same file. A new case goes in `composer-cases.json`, then the
command runs again; the file is never edited by hand.
