/**
 * Feature catalogue — single source of truth for the "what's in this
 * app" tree rendered under Options → Fonctionnalités. Every leaf MUST
 * have at least one path in `files`; paths are relative to the
 * mobile/erplibre_home_mobile/ directory.
 *
 * When you add or move a feature, update this file in the same
 * commit. See .claude/rules/01-feature-catalog.md for the full rule.
 *
 * `howItWorks` is intentionally left empty for now — to be filled in
 * a follow-up pass once each entry has been reviewed.
 */
export interface FeatureI18n {
    en: string;
    fr: string;
}

export type FeatureDemo =
    /** Navigate to an in-app route to demo the feature */
    | { kind: "route"; url: string }
    /** Open the options screen and let the user expand a section */
    | { kind: "options"; sectionId?: string }
    /** Background service / no UI — explain why it can't be demoed */
    | { kind: "none"; reason?: FeatureI18n };

export type FeatureStatus = "stable" | "experimental" | "deprecated" | "broken";

/** Capacitor / Android permission strings used by a feature. Free-form
 *  but recommended values: camera, microphone, storage, location,
 *  notifications, biometric, usb-host, internet, foreground-service. */
export type FeaturePermission = string;

export interface FeatureNode {
    /** kebab-case unique id, dotted by hierarchy */
    id: string;
    label: FeatureI18n;
    description?: FeatureI18n;
    /** Longer explanation of internals — fill in incrementally */
    howItWorks?: FeatureI18n;
    children?: FeatureNode[];
    /** Source files implementing the feature */
    files?: string[];
    /** Test files covering the feature — paths checked on disk */
    tests?: string[];
    /** Other feature ids this one depends on (must exist in tree) */
    dependsOn?: string[];
    /** Known issues / limitations, surfaced in the detail panel */
    issues?: FeatureI18n[];
    /** OS-level permissions required */
    permissions?: FeaturePermission[];
    /** Maturity / health label, defaults to "stable" if absent */
    status?: FeatureStatus;
    /** How a user can demo / launch the feature in the app */
    demo?: FeatureDemo;
}

const NONE_BG: FeatureDemo = {
    kind: "none",
    reason: {
        en: "Background service — no direct UI demo.",
        fr: "Service en arrière-plan — pas de démo UI directe.",
    },
};

const NONE_PLUMBING: FeatureDemo = {
    kind: "none",
    reason: {
        en: "Internal plumbing — used by other features.",
        fr: "Tuyauterie interne — utilisée par d'autres fonctionnalités.",
    },
};

export const FEATURE_TREE: FeatureNode[] = [
    {
        id: "notes",
        label: { en: "📝 Notes", fr: "📝 Notes" },
        description: {
            en: "Multi-entry note-taking with tags, priorities and share intents.",
            fr: "Prise de note multi-entrées avec tags, priorités et partage.",
        },
        demo: { kind: "route", url: "/notes" },
        children: [
            {
                id: "notes.list",
                label: { en: "List & filters", fr: "Liste & filtres" },
                description: {
                    en: "Browse notes, filter by tag, sort by priority/date.",
                    fr: "Parcourir, filtrer par tag, trier par priorité/date.",
                },
                status: "stable",
                howItWorks: {
                    en: "Owl component renders the notes array as Sortable.js list — drag "
                        + "handles reorder via persistDisplayOrder. Search filters client-side "
                        + "on title and entry text; tag chips toggle a Set of active tag ids "
                        + "that AND with the text query. Biometry gate (BiometryUtils) wraps "
                        + "risky actions like delete.",
                    fr: "Composant Owl rend les notes en liste Sortable.js — handles de drag "
                        + "réordonnent via persistDisplayOrder. La recherche filtre côté client "
                        + "sur titre + texte des entrées; les chips de tags togglent un Set "
                        + "d'ids qui AND avec la query texte. Garde biométrique (BiometryUtils) "
                        + "protège les actions risquées (suppression).",
                },
                dependsOn: ["security.biometry"],
                demo: { kind: "route", url: "/notes" },
                files: [
                    "src/components/note_list/note_list_component.ts",
                    "src/components/note_list/note_list_component.scss",
                    "src/components/note_list/controls/note_list_controls_component.ts",
                    "src/components/note_list/item/note_list_item_component.ts",
                    "src/components/note_list/item/handle/note_list_item_handle_component.ts",
                ],
            },
            {
                id: "notes.editor",
                label: { en: "Note editor", fr: "Éditeur de note" },
                description: {
                    en: "Edit a single note with title, controls and entry list.",
                    fr: "Édition d'une note : titre, contrôles, liste d'entrées.",
                },
                status: "stable",
                howItWorks: {
                    en: "Top-level component compositing NoteTopControls (title, tags, "
                        + "priority, date), NoteContent (entry list), NoteBottomControls (add "
                        + "buttons) and the shared TagManager + DatePicker popovers. State is "
                        + "mirrored into NoteService on every change; sync flags write through "
                        + "to the per-server sync_status table.",
                    fr: "Composant top-level qui compose NoteTopControls (titre, tags, "
                        + "priorité, date), NoteContent (liste d'entrées), NoteBottomControls "
                        + "(boutons d'ajout) et les popovers partagés TagManager + DatePicker. "
                        + "L'état est miroité dans NoteService à chaque modif; les flags sync "
                        + "écrivent vers la table sync_status par serveur.",
                },
                dependsOn: [
                    "notes.service",
                    "notes.tags",
                    "notes.priority",
                    "notes.date-picker",
                    "notes.entries.framework",
                ],
                demo: { kind: "route", url: "/note/demo" },
                files: [
                    "src/components/note/note_component.ts",
                    "src/components/note/note_component.scss",
                    "src/components/note/content/note_content_component.ts",
                    "src/components/note/top_controls/note_top_controls_component.ts",
                    "src/components/note/bottom_controls/note_bottom_controls_component.ts",
                ],
            },
            {
                id: "notes.entries",
                label: { en: "Entry types", fr: "Types d'entrées" },
                description: {
                    en: "Heterogeneous entries inside a note: text, photo, video…",
                    fr: "Entrées hétérogènes dans une note : texte, photo, vidéo…",
                },
                demo: { kind: "route", url: "/note/demo" },
                children: [
                    {
                        id: "notes.entries.text",
                        label: { en: "Text", fr: "Texte" },
                        description: {
                            en: "Plain-text entry with autosave.",
                            fr: "Entrée texte avec autosave.",
                        },
                        status: "stable",
                        howItWorks: {
                            en: "Bare <textarea> with t-model two-way binding to params.text. No "
                                + "autosave loop — the parent NoteContent watches the entry array and "
                                + "persists on patch. Keeps the component zero-state, AOT-friendly.",
                            fr: "<textarea> simple avec liaison t-model bidirectionnelle sur "
                                + "params.text. Pas de boucle d'autosave — le parent NoteContent observe "
                                + "le tableau d'entrées et persiste au patch. Composant sans état, "
                                + "compatible AOT.",
                        },
                        dependsOn: ["notes.entries.framework"],
                        demo: { kind: "route", url: "/note/demo" },
                        files: ["src/components/note_entry/text/note_entry_text_component.ts"],
                    },
                    {
                        id: "notes.entries.photo",
                        label: { en: "Photo", fr: "Photo" },
                        description: {
                            en: "Capture or pick a photo, store in note.",
                            fr: "Capturer ou choisir une photo, l'attacher à la note.",
                        },
                        permissions: ["camera"],
                        status: "stable",
                        howItWorks: {
                            en: "@capacitor/camera opens either the camera (CameraSource.Camera) or "
                                + "the gallery picker via a Dialog choice. The result is a base64 "
                                + "dataUrl stored as the entry payload — no native file copy; rendering "
                                + "uses the dataUrl directly in <img>.",
                            fr: "@capacitor/camera ouvre soit la caméra (CameraSource.Camera) soit le "
                                + "sélecteur de galerie via un Dialog. Le résultat est un dataUrl base64 "
                                + "stocké comme payload — pas de copie native; le rendu utilise le "
                                + "dataUrl directement dans <img>.",
                        },
                        dependsOn: ["notes.entries.framework"],
                        demo: { kind: "route", url: "/note/demo" },
                        files: ["src/components/note_entry/photo/note_entry_photo_component.ts"],
                    },
                    {
                        id: "notes.entries.video",
                        label: { en: "Video", fr: "Vidéo" },
                        description: {
                            en: "Record/attach a video, generate thumbnail.",
                            fr: "Enregistrer/attacher une vidéo, générer une miniature.",
                        },
                        permissions: ["camera", "microphone"],
                        status: "stable",
                        howItWorks: {
                            en: "Capacitor Camera in video mode returns a file URI; "
                                + "generateVideoThumbnail (videoThumbnailUtils) decodes the first frame "
                                + "to a poster image stored alongside the URI. The "
                                + "migrateVideoThumbnails migration backfills posters for entries "
                                + "created before that field existed.",
                            fr: "@capacitor/camera en mode vidéo retourne un URI de fichier; "
                                + "generateVideoThumbnail (videoThumbnailUtils) décode la première frame "
                                + "comme poster stocké à côté de l'URI. La migration "
                                + "migrateVideoThumbnails backfille les posters pour les entrées créées "
                                + "avant l'ajout du champ.",
                        },
                        dependsOn: ["notes.entries.framework"],
                        demo: { kind: "route", url: "/note/demo" },
                        files: [
                            "src/components/note_entry/video/note_entry_video_component.ts",
                            "src/utils/videoThumbnailUtils.ts",
                            "src/services/migrations/migrateVideoThumbnails.ts",
                        ],
                    },
                    {
                        id: "notes.entries.audio",
                        label: { en: "Audio", fr: "Audio" },
                        description: {
                            en: "Record an audio clip, optional transcription.",
                            fr: "Enregistrer un clip audio, transcription optionnelle.",
                        },
                        permissions: ["microphone"],
                        dependsOn: [
                            "transcription.bridge",
                            "notes.entries.framework",
                        ],
                        status: "stable",
                        howItWorks: {
                            en: "capacitor-voice-recorder records into base64 (in-memory) and "
                                + "writeFile() into Directory.Data under audio/<noteId>/<entryId>. The "
                                + "entry stores the relative path; playback reads through convertFileSrc "
                                + "to bypass the WebView origin check. If transcription is enabled, the "
                                + "path is passed to TranscriptionService on stop.",
                            fr: "capacitor-voice-recorder enregistre en base64 (mémoire) puis "
                                + "writeFile() dans Directory.Data sous audio/<noteId>/<entryId>. "
                                + "L'entrée stocke le path relatif; la lecture passe par convertFileSrc "
                                + "pour contourner le check d'origine WebView. Si la transcription est "
                                + "activée, le path est envoyé à TranscriptionService au stop.",
                        },
                        demo: { kind: "route", url: "/note/demo" },
                        files: ["src/components/note_entry/audio/note_entry_audio_component.ts"],
                    },
                    {
                        id: "notes.entries.date",
                        label: { en: "Date", fr: "Date" },
                        description: {
                            en: "Pin a date to the note (deadline, event, etc).",
                            fr: "Associer une date à la note (échéance, événement…).",
                        },
                        status: "stable",
                        howItWorks: {
                            en: "Click the formatted date button → emits OPEN_DATEPICKER on the event "
                                + "bus with the entry id. The shared DatePickerComponent listens, opens "
                                + "its popover anchored to the button, and writes back via "
                                + "DATE_SELECTED. One picker instance is shared across all date entries.",
                            fr: "Clic sur le bouton de date formaté → émet OPEN_DATEPICKER sur l'event "
                                + "bus avec l'id de l'entrée. Le DatePickerComponent partagé écoute, "
                                + "ouvre son popover ancré au bouton, et écrit en retour via "
                                + "DATE_SELECTED. Une seule instance de picker pour toutes les entrées "
                                + "date.",
                        },
                        dependsOn: [
                            "notes.entries.framework",
                            "notes.date-picker",
                        ],
                        demo: { kind: "route", url: "/note/demo" },
                        files: ["src/components/note_entry/date/note_entry_date_component.ts"],
                    },
                    {
                        id: "notes.entries.geolocation",
                        label: { en: "Geolocation", fr: "Géolocalisation" },
                        description: {
                            en: "Capture current GPS position into the note.",
                            fr: "Capturer la position GPS courante dans la note.",
                        },
                        permissions: ["location"],
                        status: "stable",
                        howItWorks: {
                            en: "Stores latitude/longitude/accuracy as a JSON string. Display button "
                                + "opens an HTML popover (browser-native popover API) showing formatted "
                                + "coords and accuracy radius. Capture happens in the parent note editor "
                                + "via Geolocation.getCurrentPosition.",
                            fr: "Stocke latitude/longitude/precision comme JSON. Le bouton d'affichage "
                                + "ouvre un popover HTML (API popover native du browser) avec coords "
                                + "formatées et rayon de precision. La capture se fait dans le composant "
                                + "note parent via Geolocation.getCurrentPosition.",
                        },
                        dependsOn: ["notes.entries.framework"],
                        demo: { kind: "route", url: "/note/demo" },
                        files: ["src/components/note_entry/geolocation/note_entry_geolocation_component.ts"],
                    },
                    {
                        id: "notes.entries.framework",
                        label: { en: "Framework (drag, delete)", fr: "Cadre commun (drag, delete)" },
                        description: {
                            en: "Shared shell wrapping every entry type.",
                            fr: "Coquille commune qui enveloppe chaque type d'entrée.",
                        },
                        status: "stable",
                        howItWorks: {
                            en: "NoteEntryComponent dispatches to the right concrete entry component "
                                + "by props.type ('text', 'photo', 'video' …) — the parent only renders "
                                + "<NoteEntryComponent type='photo'> and lets the framework pick. "
                                + "NoteEntryDrag and NoteEntryDelete are shared affordances rendered by "
                                + "the framework, not the entry components themselves.",
                            fr: "NoteEntryComponent dispatche vers le bon composant d'entrée concret "
                                + "selon props.type ('text', 'photo', 'video' …) — le parent rend juste "
                                + "<NoteEntryComponent type='photo'> et laisse le framework choisir. "
                                + "NoteEntryDrag et NoteEntryDelete sont des affordances partagées "
                                + "rendues par le framework, pas par les entrées elles-mêmes.",
                        },
                        demo: { kind: "route", url: "/note/demo" },
                        files: [
                            "src/components/note_entry/note_entry_component.ts",
                            "src/components/note_entry/drag/note_entry_drag_component.ts",
                            "src/components/note_entry/delete/note_entry_delete_component.ts",
                        ],
                    },
                ],
            },
            {
                id: "notes.tags",
                label: { en: "Tags", fr: "Tags" },
                description: {
                    en: "Hierarchical labelling, colour, filtering by tag.",
                    fr: "Étiquetage hiérarchique, couleur, filtre par tag.",
                },
                status: "stable",
                howItWorks: {
                    en: "Tags form a tree (parent_id self-reference) with a colour per tag. "
                        + "TagManager popover shows a search box + flat list with indentation by "
                        + "depth. TagService caches the full set in memory; invalidateCache() is "
                        + "called on add/edit/delete so subsequent reads hit SQLite again. "
                        + "getAllDescendantIds is used when filtering by a parent tag (matches "
                        + "every descendant).",
                    fr: "Tags forment un arbre (auto-référence parent_id) avec une couleur par "
                        + "tag. Le popover TagManager affiche une recherche + liste plate "
                        + "indentée par profondeur. TagService cache l'ensemble en mémoire; "
                        + "invalidateCache() est appelé à add/edit/delete pour forcer la "
                        + "prochaine lecture vers SQLite. getAllDescendantIds est utilisé pour "
                        + "filtrer par tag parent (matche tous les descendants).",
                },
                demo: { kind: "route", url: "/notes" },
                files: [
                    "src/components/tags/tag_notes_component.ts",
                    "src/components/note/tag_manager/tag_manager_component.ts",
                    "src/services/tagService.ts",
                    "src/services/migrations/addTagsTable.ts",
                    "src/models/tag.ts",
                ],
                tests: ["src/__tests__/tagService.test.ts"],
            },
            {
                id: "notes.priority",
                label: { en: "Priority", fr: "Priorité" },
                description: {
                    en: "1–4 priority badge to surface critical notes.",
                    fr: "Badge de priorité 1–4 pour faire ressortir l'urgent.",
                },
                status: "stable",
                howItWorks: {
                    en: "Eisenhower quadrant: 1 = urgent+important, 2 = important, 3 = urgent, "
                        + "4 = neither. Stored as an INTEGER in notes.priority (NULL = unset). "
                        + "NoteList sorts by priority asc then date desc when the priority "
                        + "filter chip is active. addNotePriority migration adds the column to "
                        + "existing DBs.",
                    fr: "Quadrant Eisenhower : 1 = urgent+important, 2 = important, 3 = "
                        + "urgent, 4 = ni l'un ni l'autre. Stocké en INTEGER dans notes.priority "
                        + "(NULL = absent). NoteList trie par priority asc puis date desc quand "
                        + "le chip filtre priorité est actif. Migration addNotePriority ajoute "
                        + "la colonne aux DB existantes.",
                },
                demo: { kind: "route", url: "/note/demo" },
                files: [
                    "src/components/note/top_controls/note_top_controls_component.ts",
                    "src/services/migrations/addNotePriority.ts",
                ],
            },
            {
                id: "notes.date-picker",
                label: { en: "Date picker", fr: "Sélecteur de date" },
                description: {
                    en: "Calendar popover for date entries.",
                    fr: "Popover calendrier pour les entrées de date.",
                },
                status: "stable",
                howItWorks: {
                    en: "Picks renderer based on Capacitor.isNativePlatform(): on Android the "
                        + "native @capawesome-team/capacitor-datetime-picker spinner; on web the "
                        + "air-datepicker calendar inside an HTML popover. Both emit a unified "
                        + "DATE_SELECTED on the event bus so callers don't branch.",
                    fr: "Sélectionne le renderer selon Capacitor.isNativePlatform() : sur "
                        + "Android le spinner natif @capawesome-team/capacitor-datetime-picker; "
                        + "sur web le calendrier air-datepicker dans un popover HTML. Les deux "
                        + "émettent un DATE_SELECTED unifié sur l'event bus pour éviter de "
                        + "brancher chez l'appelant.",
                },
                demo: { kind: "route", url: "/note/demo" },
                files: [
                    "src/components/note/date_picker/date_picker_component.ts",
                    "src/css/datepicker.scss",
                ],
            },
            {
                id: "notes.service",
                label: { en: "Service & CRUD", fr: "Service & CRUD" },
                description: {
                    en: "DB-level note operations and subservices.",
                    fr: "Opérations DB sur les notes et sous-services.",
                },
                status: "stable",
                howItWorks: {
                    en: "Single connection wrapper composing three subservices: "
                        + "NoteCrudSubservice (add/edit/delete/clear), NoteEntrySubservice "
                        + "(per-entry add/remove/reorder) and NoteIntentSubservice "
                        + "(newNoteWithText/Image/Video — used by the share-intent handlers). "
                        + "All three share the same DatabaseService instance and broadcast "
                        + "NOTES_CHANGED on the event bus after writes.",
                    fr: "Wrapper de connexion unique composant 3 sous-services : "
                        + "NoteCrudSubservice (add/edit/delete/clear), NoteEntrySubservice "
                        + "(add/remove/reorder par entrée) et NoteIntentSubservice "
                        + "(newNoteWithText/Image/Video — utilisés par les handlers de "
                        + "share-intent). Les 3 partagent la même DatabaseService et émettent "
                        + "NOTES_CHANGED sur l'event bus après écriture.",
                },
                demo: NONE_PLUMBING,
                files: [
                    "src/services/note/noteService.ts",
                    "src/services/note/noteCrudSubservice.ts",
                    "src/services/note/noteEntrySubservice.ts",
                    "src/services/note/noteIntentSubservice.ts",
                    "src/models/note.ts",
                ],
                tests: ["src/__tests__/noteService.test.ts"],
            },
            {
                id: "notes.share-intent",
                label: { en: "Share intent (Android)", fr: "Réception via Share intent" },
                description: {
                    en: "Receive text/image/video from another app, create a note.",
                    fr: "Recevoir texte/image/vidéo d'une autre app, créer une note.",
                },
                howItWorks: {
                    en: "CustomSendIntentActivity captures ACTION_SEND payloads "
                        + "before Capacitor mounts. The MIME prefix routes to a "
                        + "dedicated handler component which writes the entry "
                        + "and navigates to the new note.",
                    fr: "CustomSendIntentActivity intercepte les payloads "
                        + "ACTION_SEND avant que Capacitor monte. Le préfixe "
                        + "MIME route vers le bon handler qui écrit l'entrée et "
                        + "navigue vers la nouvelle note.",
                },
                status: "stable",
                dependsOn: ["notes.service"],
                demo: NONE_BG,
                files: [
                    "src/components/intent/intent_component.ts",
                    "src/components/intent-handler/note/text/note_text_intent_handler_component.ts",
                    "src/components/intent-handler/note/image/note_image_intent_handler_component.ts",
                    "src/components/intent-handler/note/video/note_video_intent_handler_component.ts",
                    "src/services/intentService.ts",
                    "src/models/intent.ts",
                    "android/app/src/main/java/ca/erplibre/home/CustomSendIntentActivity.java",
                ],
                tests: ["src/__tests__/intentService.test.ts"],
            },
        ],
    },
    {
        id: "streamdeck",
        label: { en: "🎛️ Stream Deck", fr: "🎛️ Stream Deck" },
        description: {
            en: "Drive Elgato Stream Deck devices over USB host.",
            fr: "Pilote les Elgato Stream Deck via USB host.",
        },
        demo: { kind: "options", sectionId: "streamdeck" },
        children: [
            {
                id: "streamdeck.plugin-native",
                label: { en: "Native plugin (Java)", fr: "Plugin natif Java" },
                description: {
                    en: "Capacitor plugin: USB session, key reads, image writes.",
                    fr: "Plugin Capacitor : session USB, lectures touches, écriture images.",
                },
                status: "stable",
                howItWorks: {
                    en: "Capacitor plugin (Java) wrapping the USB host stack. DeckRegistry "
                        + "keeps one DeckSession per attached device; DeckSpec carries product "
                        + "id → key count, image size, transport version. The bridge surface is "
                        + "JSON over the Capacitor JS↔Java pipe; binary frames travel as base64 "
                        + "batched on a single JNI call per deck.",
                    fr: "Plugin Capacitor (Java) qui enveloppe le stack USB host. DeckRegistry "
                        + "garde une DeckSession par appareil branché; DeckSpec porte product id "
                        + "→ nb touches, taille image, version transport. La surface bridge est "
                        + "JSON sur le pipe Capacitor JS↔Java; les frames binaires passent en "
                        + "base64 batchées en un seul appel JNI par deck.",
                },
                demo: NONE_PLUMBING,
                files: [
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/StreamDeckPlugin.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/DeckSession.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/DeckSpec.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/DeckRegistry.java",
                ],
            },
            {
                id: "streamdeck.bridge-ts",
                label: { en: "TypeScript bridge", fr: "Bridge TypeScript" },
                description: {
                    en: "Typed surface used by JS-side services.",
                    fr: "Surface typée utilisée par les services JS.",
                },
                status: "stable",
                howItWorks: {
                    en: "Thin TypeScript wrapper around the Capacitor plugin. Hides the "
                        + "camelCase↔kebab-case JSON quirks, normalises base64↔ArrayBuffer for "
                        + "image writes, and exposes typed events (keyChanged, attached, "
                        + "detached) so consumers don't import the plugin directly.",
                    fr: "Wrapper TypeScript fin sur le plugin Capacitor. Cache les bizarreries "
                        + "camelCase↔kebab-case du JSON, normalise base64↔ArrayBuffer pour les "
                        + "écritures images, et expose des events typés (keyChanged, attached, "
                        + "detached) pour éviter aux consommateurs d'importer le plugin "
                        + "directement.",
                },
                dependsOn: ["streamdeck.plugin-native"],
                demo: NONE_PLUMBING,
                files: ["src/plugins/streamDeckPlugin.ts"],
                tests: ["src/__tests__/streamDeckPlugin.test.ts"],
            },
            {
                id: "streamdeck.controller",
                label: { en: "Controller", fr: "Contrôleur" },
                description: {
                    en: "Wires Note key, sleep cycle, brightness restore.",
                    fr: "Relie la touche Note, le cycle veille, restore brightness.",
                },
                howItWorks: {
                    en: "Subscribes to keyChanged on every connected deck, "
                        + "throttled at 150 ms to dodge the WebView IME-storm "
                        + "crash. On visibilitychange:hidden each deck dims to "
                        + "0 %; brief hides only restore brightness, hides over "
                        + "5 s trigger a full restartSessions to wake the "
                        + "post-sleep-silent reader.",
                    fr: "S'abonne à keyChanged sur chaque deck, throttlé à 150 "
                        + "ms pour éviter le crash IME du WebView. Sur "
                        + "visibilitychange:hidden chaque deck dimme à 0 %; "
                        + "hides courtes restaurent juste la luminosité, hides "
                        + ">5 s déclenchent un restartSessions complet pour "
                        + "réveiller le reader silencieux après wake.",
                },
                status: "stable",
                dependsOn: [
                    "streamdeck.bridge-ts",
                    "streamdeck.lifecycle-service",
                ],
                demo: NONE_BG,
                files: ["src/services/streamDeckController.ts"],
            },
            {
                id: "streamdeck.usb",
                label: { en: "USB hotplug & permission", fr: "USB hotplug & permission" },
                description: {
                    en: "Listen for attach/detach, request OS permission per device.",
                    fr: "Écoute attach/detach, demande la permission OS par appareil.",
                },
                status: "stable",
                howItWorks: {
                    en: "UsbHotplugReceiver listens for ACTION_USB_DEVICE_ATTACHED / DETACHED "
                        + "intents from the OS. UsbPermissionRequester wraps the per-device "
                        + "PendingIntent flow: first attach prompts the user; the grant is "
                        + "sticky per Android session. Detach immediately tears down the "
                        + "DeckSession to release the FileDescriptor.",
                    fr: "UsbHotplugReceiver écoute les intents OS ACTION_USB_DEVICE_ATTACHED / "
                        + "DETACHED. UsbPermissionRequester enveloppe le flow PendingIntent par "
                        + "appareil : premier attach prompt l'utilisateur; l'autorisation est "
                        + "sticky pour la session Android. Détach démantèle immédiatement la "
                        + "DeckSession pour libérer le FileDescriptor.",
                },
                demo: NONE_BG,
                files: [
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/usb/UsbHotplugReceiver.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/usb/UsbPermissionRequester.java",
                ],
            },
            {
                id: "streamdeck.reader",
                label: { en: "Reader strategies", fr: "Stratégies reader" },
                description: {
                    en: "UsbRequest / bulk / polled fallbacks for diverse kernels.",
                    fr: "Repli UsbRequest / bulk / polled selon le kernel.",
                },
                howItWorks: {
                    en: "Default UsbRequest async on interrupt-IN works on most "
                        + "kernels. Some Android stacks shadow that endpoint, "
                        + "so bulkTransfer is offered as a sync fallback, and "
                        + "polled GET_REPORT on EP0 as last resort. Buffer "
                        + "size matches epIn.maxPacketSize (key fix: 64 B "
                        + "returned EOVERFLOW on Pixel 6 / ThinkPhone XL).",
                    fr: "Par défaut UsbRequest async sur interrupt-IN. Certains "
                        + "kernels Android cachent cet endpoint, on offre "
                        + "bulkTransfer en repli sync, et polled GET_REPORT "
                        + "sur EP0 en dernier recours. Buffer = "
                        + "epIn.maxPacketSize (fix clé: 64 B retournait "
                        + "EOVERFLOW sur Pixel 6 / ThinkPhone XL).",
                },
                status: "stable",
                dependsOn: [
                    "streamdeck.plugin-native",
                    "streamdeck.usb",
                ],
                demo: { kind: "options", sectionId: "streamdeck" },
                files: ["android/app/src/main/java/ca/erplibre/home/streamdeck/DeckSession.java"],
            },
            {
                id: "streamdeck.heartbeat",
                label: { en: "USB heartbeat", fr: "Heartbeat USB" },
                description: {
                    en: "700 ms control transfer keeping the bus active.",
                    fr: "Control transfer 700 ms pour garder le bus actif.",
                },
                howItWorks: {
                    en: "Per-session daemon thread issuing GET_REPORT (firmware "
                        + "version) every 700 ms. Without it, Android USB "
                        + "selective suspend stops driving SOFs once the "
                        + "screen goes off and the deck firmware reacts by "
                        + "pulsing LCD brightness at ~1 Hz. Cheap (separate "
                        + "endpoint from reader/writer, no contention).",
                    fr: "Thread daemon par session qui envoie un GET_REPORT "
                        + "(version firmware) toutes les 700 ms. Sans ça, "
                        + "l'autosuspend USB Android arrête les SOFs dès "
                        + "l'écran off et le firmware réagit en pulsant la "
                        + "LCD à ~1 Hz. Coût faible (endpoint séparé, pas "
                        + "de contention).",
                },
                status: "stable",
                dependsOn: ["streamdeck.plugin-native"],
                demo: NONE_BG,
                files: ["android/app/src/main/java/ca/erplibre/home/streamdeck/DeckSession.java"],
            },
            {
                id: "streamdeck.writer-queue",
                label: { en: "Writer queue", fr: "Writer queue" },
                description: {
                    en: "Coalesced image-write jobs flushed by a single thread.",
                    fr: "Files d'écriture images coalescées, drainées par un thread.",
                },
                howItWorks: {
                    en: "Each (deck, key) is a slot; offering a new job for an "
                        + "existing slot replaces the previous one (which "
                        + "resolves as `dropped`). Single consumer thread "
                        + "drains via bulk-OUT. clearPendingWrites() empties "
                        + "the queue without closing it — used by the camera "
                        + "streamer on stop to avoid the firmware-busy lag.",
                    fr: "Chaque (deck, key) est un slot ; offrir un nouveau job "
                        + "pour un slot existant remplace l'ancien (résolu "
                        + "comme `dropped`). Thread consommateur unique drain "
                        + "via bulk-OUT. clearPendingWrites() vide la queue "
                        + "sans la fermer — utilisé par le streamer sur stop.",
                },
                status: "stable",
                dependsOn: [
                    "streamdeck.transports",
                    "streamdeck.encoders",
                ],
                demo: NONE_PLUMBING,
                files: [
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/WriterQueue.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/WriteJob.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/ImageWriteJob.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/LcdWriteJob.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/NeoInfoBarWriteJob.java",
                ],
            },
            {
                id: "streamdeck.encoders",
                label: { en: "Image encoders (JPEG/BMP)", fr: "Encoders image (JPEG/BMP)" },
                description: {
                    en: "Per-model image format used over USB.",
                    fr: "Format image USB selon le modèle.",
                },
                status: "stable",
                howItWorks: {
                    en: "Per-model image encoder picked by DeckSpec: V1 decks accept BMP raw, "
                        + "V2 decks accept JPEG (better compression, faster USB transfer). "
                        + "Encoders run on a worker thread so the main thread isn't blocked "
                        + "during a full-deck refresh.",
                    fr: "Encoder image par modèle choisi par DeckSpec : decks V1 acceptent du "
                        + "BMP brut, decks V2 du JPEG (meilleure compression, transfert USB plus "
                        + "rapide). Les encoders tournent sur un thread worker pour ne pas "
                        + "bloquer le main thread lors d'un refresh complet.",
                },
                demo: NONE_PLUMBING,
                files: ["android/app/src/main/java/ca/erplibre/home/streamdeck/encoder"],
            },
            {
                id: "streamdeck.transports",
                label: { en: "Transports V1 / V2", fr: "Transports V1 / V2" },
                description: {
                    en: "Pagination + USB framing per protocol generation.",
                    fr: "Pagination et framing USB selon la génération.",
                },
                status: "stable",
                howItWorks: {
                    en: "V1 transport (Original Stream Deck) writes 16 KiB pages with a "
                        + "prepended report id and page index; V2 transport (Mk.2, XL, Plus, "
                        + "Neo, Pedal) writes 1024-byte pages with the new framing. Choice is "
                        + "driven by DeckSpec.transportVersion — encoders never see the wire "
                        + "format directly.",
                    fr: "Transport V1 (Stream Deck Original) écrit des pages de 16 KiB avec "
                        + "report id + index de page en préfixe; transport V2 (Mk.2, XL, Plus, "
                        + "Neo, Pedal) écrit des pages 1024 bytes avec le nouveau framing. Le "
                        + "choix est piloté par DeckSpec.transportVersion — les encoders ne "
                        + "voient pas le format wire directement.",
                },
                demo: NONE_PLUMBING,
                files: ["android/app/src/main/java/ca/erplibre/home/streamdeck/transport"],
            },
            {
                id: "streamdeck.lifecycle-service",
                label: { en: "Lifecycle service", fr: "Service de cycle de vie" },
                description: {
                    en: "Catches swipe-from-recents to blank decks.",
                    fr: "Capte le swipe-recents pour blanker les decks.",
                },
                status: "stable",
                howItWorks: {
                    en: "Foreground service started with FLAG_FOREGROUND_SERVICE_DATA_SYNC. "
                        + "Its onTaskRemoved fires when the user swipes the app from Recents — "
                        + "we use that hook to blank every connected deck before exit so the "
                        + "keys don't keep showing the last frame after the WebView is gone.",
                    fr: "Foreground service démarré avec FLAG_FOREGROUND_SERVICE_DATA_SYNC. "
                        + "Son onTaskRemoved fire quand l'user swipe l'app depuis Recents — on "
                        + "utilise ce hook pour blanker chaque deck connecté avant de quitter, "
                        + "sinon les touches gardent la dernière frame après que le WebView soit "
                        + "mort.",
                },
                demo: NONE_BG,
                files: ["android/app/src/main/java/ca/erplibre/home/streamdeck/StreamDeckLifecycleService.java"],
            },
            {
                id: "streamdeck.camera-stream",
                label: { en: "Camera streaming → deck", fr: "Streaming caméra → deck" },
                description: {
                    en: "Stream phone camera onto deck keys (cover-fit, bezel-aware).",
                    fr: "Diffuse la caméra du téléphone sur les touches (cover-fit, bezels).",
                },
                status: "stable",
                permissions: ["camera"],
                dependsOn: ["streamdeck.controller", "streamdeck.writer-queue"],
                issues: [
                    { en: "Front camera mirror is off; user-facing scenes look reversed.",
                      fr: "Caméra avant non miroitée; scène vue à l'envers." },
                ],
                howItWorks: {
                    en: "getUserMedia → hidden <video> → composite canvas "
                        + "cover-fit per deck (with bezel-gap padding) → tile "
                        + "crop per key → toDataURL JPEG (sync, ~5–10× faster "
                        + "than toBlob in WebView) → setKeyImagesBatch (one "
                        + "JNI call per deck). Auto-pause on visibility hidden "
                        + "and resume on visible.",
                    fr: "getUserMedia → <video> caché → canvas composite "
                        + "cover-fit par deck (avec gap bezels) → crop tile "
                        + "par touche → toDataURL JPEG (sync, ~5–10× plus "
                        + "rapide que toBlob dans WebView) → setKeyImagesBatch "
                        + "(un seul JNI par deck). Auto-pause sur "
                        + "visibility hidden, resume sur visible.",
                },
                demo: { kind: "options", sectionId: "camera-stream" },
                files: [
                    "src/services/streamDeckCameraStreamer.ts",
                    "src/components/options/camera_stream/options_camera_stream_component.ts",
                    "src/components/options/camera_stream/options_camera_stream_component.scss",
                ],
            },
            {
                id: "streamdeck.face-detection",
                label: { en: "Face detection", fr: "Détection de visage" },
                description: {
                    en: "ML Kit detects faces, draws a green border on hit tiles.",
                    fr: "ML Kit détecte les visages, cadre vert sur les tuiles touchées.",
                },
                status: "experimental",
                permissions: ["camera"],
                dependsOn: ["streamdeck.camera-stream"],
                howItWorks: {
                    en: "Per tick: downscale the live video to ~640 px on its "
                        + "long edge (aspect-preserving), JPEG-encode at q=0.5, "
                        + "ship to ML Kit FaceDetection in ACCURATE mode via a "
                        + "JNI bridge. Bounding boxes come back as normalised "
                        + "[0,1] coords; paintDeck reprojects them onto each "
                        + "deck's composite cover-fit transform.",
                    fr: "Par tick: downscale du flux à ~640 px sur la longue "
                        + "arête (aspect préservé), encode JPEG q=0.5, envoie "
                        + "à ML Kit FaceDetection ACCURATE via JNI. Bbox "
                        + "retournés en coords normalisées [0,1] ; paintDeck "
                        + "reproject sur le cover-fit composite de chaque deck.",
                },
                demo: { kind: "options", sectionId: "camera-stream" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/FaceDetectionPlugin.java",
                    "src/plugins/faceDetectionPlugin.ts",
                ],
            },
            {
                id: "streamdeck.lcd-text",
                label: { en: "LCD text marquee (Plus)", fr: "Texte LCD défilant (Plus)" },
                description: {
                    en: "Render scrolling text on the Plus LCD strip.",
                    fr: "Affiche un texte défilant sur la bande LCD du Plus.",
                },
                howItWorks: {
                    en: "15 fps tick. Static frames are rendered once and "
                        + "deduped via a hash of (text, font, colour, scrollX) "
                        + "so a still text only writes once. When the text is "
                        + "wider than the LCD it scrolls and the text is drawn "
                        + "twice (offset by gap) for a wrap-around marquee.",
                    fr: "Tick 15 fps. Frames statiques rendues une fois et "
                        + "dédupées via hash (texte, police, couleur, "
                        + "scrollX) — donc texte fixe = 1 seule écriture. "
                        + "Si le texte est plus large que la LCD, il scroll "
                        + "avec un double-draw décalé pour la boucle.",
                },
                status: "stable",
                dependsOn: [
                    "streamdeck.writer-queue",
                    "streamdeck.controller",
                ],
                demo: { kind: "options", sectionId: "streamdeck" },
                files: ["src/services/streamDeckLcdTextRenderer.ts"],
            },
            {
                id: "streamdeck.event-log",
                label: { en: "Event journal", fr: "Journal d'événements" },
                description: {
                    en: "Ring-buffer of plugin events for the diagnostic panel.",
                    fr: "Ring-buffer des événements pour le panel diagnostique.",
                },
                status: "stable",
                howItWorks: {
                    en: "In-memory ring-buffer (cap 500) of (timestamp, text) entries pushed "
                        + "to the front so newest is index 0. Subscribers fire on every add or "
                        + "clear; getAll() returns a snapshot the diagnostic panel renders "
                        + "from. Listener exceptions are isolated so logging never breaks.",
                    fr: "Ring-buffer mémoire (cap 500) d'entrées (timestamp, texte) poussées "
                        + "en tête — newest à l'index 0. Les souscripteurs fire à chaque add "
                        + "ou clear; getAll() retourne un snapshot que le panel diagnostique "
                        + "rend. Les exceptions de listener sont isolées pour ne jamais "
                        + "casser le logging.",
                },
                dependsOn: ["streamdeck.bridge-ts"],
                demo: { kind: "options", sectionId: "streamdeck" },
                files: ["src/services/streamDeckEventLog.ts"],
                tests: ["src/__tests__/streamDeckEventLog.test.ts"],
            },
            {
                id: "streamdeck.options-panel",
                label: { en: "Diagnostic panel", fr: "Panel diagnostique" },
                description: {
                    en: "Per-deck brightness, reader mode, bezel sliders, restart.",
                    fr: "Brightness, reader mode, sliders bezels, redémarrage.",
                },
                status: "stable",
                howItWorks: {
                    en: "Owl panel listing every connected deck with: brightness slider "
                        + "(persisted localStorage), reader-mode dropdown (request/bulk/polled), "
                        + "bezel-gap sliders for the camera-stream cover-fit, and a manual "
                        + "restart button that triggers restartSessions to recover from the "
                        + "post-sleep silent-reader state.",
                    fr: "Panel Owl listant chaque deck connecté avec : slider brightness "
                        + "(persisté localStorage), dropdown reader-mode (request/bulk/polled), "
                        + "sliders gap de bezels pour le cover-fit camera-stream, et un bouton "
                        + "restart manuel qui déclenche restartSessions pour récupérer du state "
                        + "reader-silencieux post-sleep.",
                },
                dependsOn: [
                    "streamdeck.controller",
                    "streamdeck.event-log",
                ],
                demo: { kind: "options", sectionId: "streamdeck" },
                files: [
                    "src/components/options/streamdeck/options_streamdeck_component.ts",
                    "src/components/options/streamdeck/options_streamdeck_component.scss",
                ],
            },
        ],
    },
    {
        id: "camera",
        label: { en: "📷 Camera", fr: "📷 Caméra" },
        description: {
            en: "Camera viewer and ML Kit OCR.",
            fr: "Visionneuse caméra et OCR ML Kit.",
        },
        children: [
            {
                id: "camera.viewer",
                label: { en: "Camera viewer", fr: "Visionneuse caméra" },
                description: {
                    en: "Live preview with OCR overlay.",
                    fr: "Aperçu live avec overlay OCR.",
                },
                permissions: ["camera"],
                status: "stable",
                howItWorks: {
                    en: "getUserMedia opens the device camera into a hidden <video>; the OCR "
                        + "overlay is a positioned <canvas> matching the video's intrinsic "
                        + "resolution. Scan toggling lives in the component state; the actual "
                        + "recognition runs in the OcrPlugin (ML Kit) on a tick.",
                    fr: "getUserMedia ouvre la caméra dans un <video> caché; l'overlay OCR est "
                        + "un <canvas> positionné qui matche la résolution intrinsèque de la "
                        + "vidéo. Le toggle de scan est dans le state du composant; la "
                        + "reconnaissance tourne dans OcrPlugin (ML Kit) à chaque tick.",
                },
                demo: NONE_BG,
                files: [
                    "src/components/video_camera/video_camera_component.ts",
                    "src/components/video_camera/video_camera_component.scss",
                ],
            },
            {
                id: "camera.ocr",
                label: { en: "OCR (ML Kit)", fr: "OCR (ML Kit)" },
                description: {
                    en: "On-device text recognition over the camera stream.",
                    fr: "Reconnaissance de texte sur le flux caméra (sur appareil).",
                },
                status: "stable",
                permissions: ["camera"],
                howItWorks: {
                    en: "Native plugin (OcrPlugin.java) wraps Google ML Kit text recognition. "
                        + "JS sends a base64-encoded JPEG; the plugin decodes via "
                        + "InputImage.fromBitmap, runs TextRecognition.process and returns "
                        + "blocks with normalised bounding boxes. ML Kit downloads its model "
                        + "lazily on first use — on-device after that.",
                    fr: "Plugin natif (OcrPlugin.java) qui enveloppe la reconnaissance de "
                        + "texte de Google ML Kit. JS envoie un JPEG base64; le plugin décode "
                        + "via InputImage.fromBitmap, run TextRecognition.process et retourne "
                        + "des blocs avec bbox normalisées. ML Kit télécharge son modèle "
                        + "paresseusement à la 1re utilisation — sur-appareil ensuite.",
                },
                demo: NONE_BG,
                files: [
                    "android/app/src/main/java/ca/erplibre/home/OcrPlugin.java",
                    "src/plugins/ocrPlugin.ts",
                ],
                tests: ["src/__tests__/ocrPlugin.test.ts"],
            },
        ],
    },
    {
        id: "sync",
        label: { en: "🔄 Odoo sync", fr: "🔄 Sync Odoo" },
        description: {
            en: "Push/pull notes between the app and Odoo servers.",
            fr: "Push/pull des notes entre l'app et les serveurs Odoo.",
        },
        demo: { kind: "options", sectionId: "sync" },
        children: [
            {
                id: "sync.service",
                label: { en: "Sync service", fr: "Service de synchronisation" },
                description: {
                    en: "Per-server status, conflict resolution, retry.",
                    fr: "Statut par serveur, résolution conflits, retry.",
                },
                status: "stable",
                permissions: ["internet"],
                tests: ["src/__tests__/syncService.test.ts"],
                howItWorks: {
                    en: "Each note tracks (odoo_id, sync_status, "
                        + "last_synced_at, sync_config_id) plus a multi-server "
                        + "selection. Pull diffs are merged client-side using "
                        + "last-modified-wins per field; conflicts surface in "
                        + "the UI for explicit resolution.",
                    fr: "Chaque note stocke (odoo_id, sync_status, "
                        + "last_synced_at, sync_config_id) + sélection "
                        + "multi-serveurs. Les diffs pull sont mergés client "
                        + "en last-modified-wins par champ ; les conflits "
                        + "remontent en UI pour résolution explicite.",
                },
                dependsOn: ["deployment.applications"],
                demo: NONE_BG,
                files: [
                    "src/services/syncService.ts",
                    "src/models/syncConfig.ts",
                ],
            },
            {
                id: "sync.options",
                label: { en: "Sync options panel", fr: "Panel sync (options)" },
                description: {
                    en: "Configure which server to sync each note with.",
                    fr: "Configurer quel serveur synchronise chaque note.",
                },
                status: "stable",
                howItWorks: {
                    en: "Lists every Application configured in the app, with toggles per note "
                        + "for which servers it should sync to. The selection is stored in "
                        + "note.selected_sync_config_ids (CSV of ids) so a single note can "
                        + "target multiple Odoo instances. Saving here triggers "
                        + "notificationService.reload().",
                    fr: "Liste chaque Application configurée, avec des toggles par note pour "
                        + "quels serveurs synchroniser. La sélection est stockée dans "
                        + "note.selected_sync_config_ids (CSV d'ids) pour qu'une note puisse "
                        + "cibler plusieurs instances Odoo. Sauvegarder ici déclenche "
                        + "notificationService.reload().",
                },
                dependsOn: ["sync.service"],
                demo: { kind: "options", sectionId: "sync" },
                files: ["src/components/options/sync/options_sync_component.ts"],
            },
            {
                id: "sync.migrations",
                label: { en: "Sync migrations", fr: "Migrations sync" },
                description: {
                    en: "DB schema additions for sync metadata.",
                    fr: "Ajouts schéma DB pour les métadonnées sync.",
                },
                status: "stable",
                howItWorks: {
                    en: "Versioned schema steps that grew the sync feature: addSyncColumns "
                        + "(initial odoo_id + sync_status), addSyncConfigId (per-server "
                        + "binding), addSyncPerServerStatus (separate sync_status row per "
                        + "target), addSelectedSyncConfigIds (multi-select). Each migration is "
                        + "idempotent and re-runs safely on app start.",
                    fr: "Étapes de schéma versionnées qui ont fait grandir la sync : "
                        + "addSyncColumns (odoo_id + sync_status initiaux), addSyncConfigId "
                        + "(binding par serveur), addSyncPerServerStatus (ligne sync_status par "
                        + "cible), addSelectedSyncConfigIds (multi-select). Chaque migration est "
                        + "idempotente et se ré-exécute sans risque au boot.",
                },
                dependsOn: ["data.migrations"],
                demo: NONE_PLUMBING,
                files: [
                    "src/services/migrations/addSyncColumns.ts",
                    "src/services/migrations/addSyncConfigId.ts",
                    "src/services/migrations/addSyncPerServerStatus.ts",
                    "src/services/migrations/addSelectedSyncConfigIds.ts",
                ],
            },
            {
                id: "sync.notifications",
                label: { en: "Push notifications (ntfy)", fr: "Notifications push (ntfy)" },
                description: {
                    en: "Server pushes a sync trigger via ntfy.sh.",
                    fr: "Le serveur envoie un trigger sync via ntfy.sh.",
                },
                permissions: ["internet", "notifications"],
                status: "stable",
                howItWorks: {
                    en: "NTFY (self-hosted SSE push) lets Odoo notify the app when something "
                        + "changed without a poll. NtfyService opens the SSE stream (with "
                        + "optional Bearer token); on each message NotificationService.poll is "
                        + "fired so the user sees the change without waiting for the next timer "
                        + "tick. Falls back to interval polling if NTFY isn't configured.",
                    fr: "NTFY (push SSE self-hosted) permet à Odoo de notifier l'app sans "
                        + "poll. NtfyService ouvre le stream SSE (avec token Bearer optionnel); "
                        + "à chaque message NotificationService.poll est déclenché pour que "
                        + "l'user voie le changement sans attendre le prochain tick. Fallback "
                        + "sur polling périodique si NTFY n'est pas configuré.",
                },
                dependsOn: [
                    "sync.service",
                    "system.processes",
                ],
                demo: NONE_BG,
                files: [
                    "src/services/ntfyService.ts",
                    "src/services/notificationService.ts",
                    "src/services/migrations/addNtfyTokenColumn.ts",
                ],
                tests: [
                    "src/__tests__/ntfyService.test.ts",
                    "src/__tests__/notificationService.test.ts",
                ],
            },
        ],
    },
    {
        id: "code",
        label: { en: "💻 Code", fr: "💻 Code" },
        description: {
            en: "View, edit and format source files in repo bundles.",
            fr: "Voir, éditer et formater les fichiers source dans les bundles.",
        },
        demo: { kind: "route", url: "/options/code" },
        children: [
            {
                id: "code.viewer",
                label: { en: "Viewer / editor", fr: "Visionneuse / éditeur" },
                description: {
                    en: "Browse repos, edit files, save back to in-place store.",
                    fr: "Parcourir repos, éditer, sauvegarder en place.",
                },
                status: "stable",
                howItWorks: {
                    en: "Tree-on-the-left + content-on-the-right Owl page. The right pane "
                        + "calls into syntax_highlight.ts which detects file lang from extension "
                        + "and runs Prism per line; soft-wrap and tab-width are localStorage "
                        + "prefs. URL deep-link (?target=&path=) auto-opens a specific bundle "
                        + "and selects a file at boot.",
                    fr: "Page Owl arbre-à-gauche + contenu-à-droite. Le pane de droite appelle "
                        + "syntax_highlight.ts qui détecte la lang du fichier par extension et "
                        + "fait tourner Prism par ligne; soft-wrap et tab-width sont des prefs "
                        + "localStorage. Deep-link URL (?target=&path=) ouvre un bundle précis "
                        + "et sélectionne un fichier au boot.",
                },
                dependsOn: [
                    "repos.bundle-code",
                    "repos.fs-factory",
                ],
                demo: { kind: "route", url: "/options/code" },
                files: [
                    "src/components/options/code/options_code_component.ts",
                    "src/components/options/code/options_code_component.scss",
                    "src/components/options/code/syntax_highlight.ts",
                ],
                tests: ["src/__tests__/syntaxHighlight.test.ts"],
            },
            {
                id: "code.style",
                label: { en: "Code style (black/prettier)", fr: "Style (black/prettier)" },
                description: {
                    en: "Run formatters against a file or repo.",
                    fr: "Lance les formatteurs sur un fichier ou un repo.",
                },
                status: "stable",
                howItWorks: {
                    en: "Customisable colour overrides for the code-tool buttons + git-status "
                        + "hues. Each entry maps a prefKey ↔ CSS custom property (read by SCSS "
                        + "as var(--…, fallback)). Overrides live in user_graphic_prefs "
                        + "(SQLite); applied on documentElement at boot via "
                        + "CodeStyleService.loadAndApply.",
                    fr: "Overrides de couleurs custom pour les boutons du code-tool + teintes "
                        + "git-status. Chaque entrée mappe prefKey ↔ propriété CSS (lue par SCSS "
                        + "via var(--…, fallback)). Les overrides vivent dans user_graphic_prefs "
                        + "(SQLite); appliquées sur documentElement au boot via "
                        + "CodeStyleService.loadAndApply.",
                },
                dependsOn: ["ui.theme"],
                demo: { kind: "options", sectionId: "code-style" },
                files: [
                    "src/services/codeStyleService.ts",
                    "src/components/options/code_style/options_code_style_component.ts",
                ],
                tests: ["src/__tests__/codeStyleService.test.ts"],
            },
            {
                id: "code.editable",
                label: { en: "Editable code repos", fr: "Repos éditables" },
                description: {
                    en: "Persist user edits in a SQLite-backed overlay.",
                    fr: "Persiste les édits user dans un overlay SQLite.",
                },
                status: "stable",
                howItWorks: {
                    en: "User edits are not written back to the bundled tarballs (read-only). "
                        + "Instead EditableCodeService extracts a repo into Directory.Data/repos "
                        + "on first edit and treats that copy as the working tree. "
                        + "isomorphic-git operates on the overlay; bundle reads fall back to the "
                        + "tarball when the overlay is absent.",
                    fr: "Les édits user ne sont pas écrits dans les tarballs bundlés (lecture "
                        + "seule). EditableCodeService extrait le repo dans Directory.Data/repos "
                        + "à la 1re édition et traite cette copie comme le working tree. "
                        + "isomorphic-git opère sur l'overlay; les lectures bundle retombent sur "
                        + "le tarball si l'overlay est absent.",
                },
                dependsOn: [
                    "repos.edit",
                    "code.viewer",
                ],
                demo: NONE_PLUMBING,
                files: [
                    "src/services/editableCodeService.ts",
                    "src/services/migrations/addEditableReposTable.ts",
                ],
                tests: ["src/__tests__/editableCodeService.test.ts"],
            },
            {
                id: "code.git",
                label: { en: "Git ops (isomorphic-git)", fr: "Git ops (isomorphic-git)" },
                description: {
                    en: "Git status / diff / commit on bundled repos.",
                    fr: "Status / diff / commit Git sur repos bundlés.",
                },
                howItWorks: {
                    en: "isomorphic-git operates on a virtual FS (capacitor "
                        + "filesystem adapter for the in-place edit overlay, "
                        + "or read-only tarball reader for shipped bundles). "
                        + "Same JS git stack as the desktop, no native libgit2.",
                    fr: "isomorphic-git tourne sur un FS virtuel (adapter "
                        + "capacitor filesystem pour l'overlay d'édition, ou "
                        + "lecteur tarball en lecture seule pour les bundles). "
                        + "Même stack JS git que sur desktop, pas de "
                        + "libgit2 natif.",
                },
                status: "stable",
                dependsOn: [
                    "code.editable",
                    "repos.fs-factory",
                ],
                demo: { kind: "route", url: "/options/code" },
                files: [
                    "src/services/codeService.ts",
                    "src/services/git/capacitorFsAdapter.ts",
                    "src/models/gitTypes.ts",
                ],
                tests: [
                    "src/__tests__/codeService.test.ts",
                    "src/__tests__/capacitorFsAdapter.test.ts",
                ],
            },
        ],
    },
    {
        id: "repos",
        label: { en: "📦 Repos & bundles", fr: "📦 Repos & bundles" },
        description: {
            en: "Manifest tarballs of source repos shipped with the APK.",
            fr: "Tarballs de repos source bundlés avec l'APK.",
        },
        children: [
            {
                id: "repos.bundle-source",
                label: { en: "Build-time bundler", fr: "Bundler au build" },
                description: {
                    en: "Vite plugin: pack manifest repos into tar.gz at build.",
                    fr: "Plugin Vite : packe les repos manifests en tar.gz au build.",
                },
                howItWorks: {
                    en: "Custom Vite plugin reads the Google-Repo manifest, "
                        + "tars each project (parallel pool sized to nproc) "
                        + "and writes them to src/public/repos/ alongside a "
                        + "manifest.json. Build flags BUNDLE_SKIP_REPOS and "
                        + "BUNDLE_SKIP_ERPLIBRE shave APK size for dev loops.",
                    fr: "Plugin Vite custom : lit le manifest Google-Repo, "
                        + "tar chaque projet (pool parallèle = nproc) et "
                        + "écrit dans src/public/repos/ avec un manifest.json. "
                        + "Flags BUNDLE_SKIP_REPOS et BUNDLE_SKIP_ERPLIBRE "
                        + "réduisent la taille APK en dev.",
                },
                status: "stable",
                demo: NONE_BG,
                files: ["vite.config.ts"],
            },
            {
                id: "repos.bundle-code",
                label: { en: "Bundle code service", fr: "Service bundle code" },
                description: {
                    en: "Resolve a path inside a bundled tarball at runtime.",
                    fr: "Résout un path dans un tarball bundlé à l'exécution.",
                },
                status: "stable",
                howItWorks: {
                    en: "Resolves a (target, path) pair to bytes at runtime. For target=mobile "
                        + "it dispatches to the editable overlay if present, else to the "
                        + "in-place bundle FS via repoFsFactory. Caches stat results in memory "
                        + "so repeated tree expansions don't re-extract.",
                    fr: "Résout une paire (target, path) en bytes au runtime. Pour "
                        + "target=mobile dispatche vers l'overlay éditable s'il existe, sinon "
                        + "vers le FS bundle in-place via repoFsFactory. Cache les résultats "
                        + "stat en mémoire pour ne pas re-extraire à chaque expansion d'arbre.",
                },
                dependsOn: [
                    "repos.extractor",
                    "repos.fs-factory",
                ],
                demo: NONE_PLUMBING,
                files: ["src/services/bundleCodeService.ts"],
                tests: ["src/__tests__/bundleCodeService.test.ts"],
            },
            {
                id: "repos.extractor",
                label: { en: "Repo extractor", fr: "Extracteur de repo" },
                description: {
                    en: "Stream-extract files from tar.gz on demand.",
                    fr: "Extrait fichiers d'un tar.gz à la volée.",
                },
                status: "stable",
                howItWorks: {
                    en: "Streams a tar.gz from a fetched ArrayBuffer through decompressGzip "
                        + "(pure-JS DEFLATE) into tarParser, which walks the 512-byte block "
                        + "format and yields { name, size, type, data } records. Lazy: a single "
                        + "getFileBytes(path) only inflates and parses up to the matching entry, "
                        + "then bails.",
                    fr: "Stream un tar.gz depuis un ArrayBuffer via decompressGzip (DEFLATE "
                        + "pure-JS) vers tarParser qui parcourt le format en blocs de 512 bytes "
                        + "et yield des records { name, size, type, data }. Paresseux : un "
                        + "getFileBytes(path) n'inflate et parse que jusqu'à l'entrée qui "
                        + "matche, puis sort.",
                },
                dependsOn: ["repos.bundle-source"],
                demo: NONE_PLUMBING,
                files: [
                    "src/services/repoExtractorService.ts",
                    "src/utils/tarParser.ts",
                    "src/utils/decompressGzip.ts",
                ],
                tests: [
                    "src/__tests__/repoExtractorService.test.ts",
                    "src/__tests__/tarParser.test.ts",
                    "src/__tests__/decompressGzip.test.ts",
                ],
            },
            {
                id: "repos.edit",
                label: { en: "Repo in-place edit", fr: "Édition repo en place" },
                description: {
                    en: "Mutate a file inside a bundle and persist it.",
                    fr: "Modifier un fichier dans un bundle et persister.",
                },
                status: "stable",
                howItWorks: {
                    en: "Wraps the editable-overlay FS for one repo: writeFile / deleteFile / "
                        + "stat / listDir, all rooted at Directory.Data/repos/<repo>/. Used by "
                        + "code.viewer when promoting a read-only bundle to editable, and by "
                        + "code.git for the working tree behind isomorphic-git.",
                    fr: "Enveloppe le FS overlay éditable pour un repo : writeFile / "
                        + "deleteFile / stat / listDir, tous racinés à "
                        + "Directory.Data/repos/<repo>/. Utilisé par code.viewer pour promouvoir "
                        + "un bundle read-only en éditable, et par code.git comme working tree "
                        + "derrière isomorphic-git.",
                },
                dependsOn: [
                    "repos.fs-factory",
                    "repos.extractor",
                ],
                demo: NONE_PLUMBING,
                files: ["src/services/repoEditService.ts"],
                tests: ["src/__tests__/repoEditService.test.ts"],
            },
            {
                id: "repos.fs-factory",
                label: { en: "FS factory", fr: "FS factory" },
                description: {
                    en: "Choose between bundle FS, edit FS or native FS.",
                    fr: "Sélectionne FS bundle / édit / natif selon le contexte.",
                },
                status: "stable",
                howItWorks: {
                    en: "Single entry point for everything that wants a repo FS handle. Picks "
                        + "BundleFs (read-only tar) by default, swaps to EditableFs (Documents "
                        + "overlay) when the user has promoted the repo. Hides the choice from "
                        + "callers — both implementations expose the same readFile/listDir/stat "
                        + "surface.",
                    fr: "Point d'entrée unique pour tout ce qui veut un FS de repo. Pick "
                        + "BundleFs (tar read-only) par défaut, swap vers EditableFs (overlay "
                        + "Documents) si l'user a promu le repo. Cache le choix aux appelants — "
                        + "les deux implémentations exposent la même surface "
                        + "readFile/listDir/stat.",
                },
                demo: NONE_PLUMBING,
                files: ["src/services/repoFsFactory.ts"],
            },
            {
                id: "repos.manifest",
                label: { en: "Manifest model", fr: "Modèle manifest" },
                description: {
                    en: "TypeScript shape for a manifest project entry.",
                    fr: "Forme TypeScript d'une entrée projet du manifest.",
                },
                status: "stable",
                howItWorks: {
                    en: "TypeScript shape mirroring an entry from the Google-Repo XML manifest "
                        + "(name, path, remote, revision, groups). Built by the vite plugin at "
                        + "bundle-time and embedded in src/public/repos/manifest.json so the "
                        + "runtime can list and resolve projects without parsing XML.",
                    fr: "Forme TypeScript qui mirroir une entrée du manifest XML Google-Repo "
                        + "(name, path, remote, revision, groups). Construit par le plugin vite "
                        + "au bundle-time et embarqué dans src/public/repos/manifest.json — le "
                        + "runtime peut lister et résoudre les projets sans parser de XML.",
                },
                demo: NONE_PLUMBING,
                files: ["src/models/manifestProject.ts"],
            },
        ],
    },
    {
        id: "transcription",
        label: { en: "🎙️ Whisper transcription", fr: "🎙️ Transcription Whisper" },
        description: {
            en: "On-device speech-to-text via whisper.cpp.",
            fr: "Speech-to-text sur appareil via whisper.cpp.",
        },
        demo: { kind: "route", url: "/options/transcription" },
        children: [
            {
                id: "transcription.native",
                label: { en: "Native plugin (NDK)", fr: "Plugin natif (NDK)" },
                description: {
                    en: "JNI bridge to whisper.cpp built via CMake.",
                    fr: "Bridge JNI vers whisper.cpp compilé via CMake.",
                },
                status: "stable",
                permissions: ["microphone"],
                howItWorks: {
                    en: "whisper.cpp is checked out under android/app/src/main/"
                        + "cpp/whisper and built as a static lib by CMake. The "
                        + "JNI shim (whisper_jni.cpp) wraps it as "
                        + "libwhisper_jni.so. WhisperLib statically loads the "
                        + "library; WhisperPlugin exposes load/transcribe to JS.",
                    fr: "whisper.cpp est cloné dans android/app/src/main/cpp/"
                        + "whisper et compilé en lib statique par CMake. Le "
                        + "shim JNI (whisper_jni.cpp) l'enveloppe en "
                        + "libwhisper_jni.so. WhisperLib charge la lib en "
                        + "static; WhisperPlugin expose load/transcribe à JS.",
                },
                demo: NONE_PLUMBING,
                files: [
                    "android/app/src/main/cpp/whisper_jni.cpp",
                    "android/app/src/main/cpp/CMakeLists.txt",
                    "android/app/src/main/java/ca/erplibre/home/WhisperPlugin.java",
                    "android/app/src/main/java/ca/erplibre/home/WhisperLib.java",
                ],
            },
            {
                id: "transcription.download",
                label: { en: "Model download", fr: "Téléchargement modèles" },
                description: {
                    en: "Download whisper models with resume + WakeLock.",
                    fr: "Télécharge les modèles whisper (resume + WakeLock).",
                },
                status: "stable",
                howItWorks: {
                    en: "Foreground service downloading whisper .bin model files (50 MB to 1 "
                        + "GB) with HTTP Range resume, MD5 checksum verification and a WakeLock "
                        + "so the download survives screen-off. Progress is broadcast via "
                        + "LocalNotification so the user can monitor outside the app.",
                    fr: "Foreground service qui télécharge les fichiers .bin whisper (50 MB à "
                        + "1 GB) avec resume HTTP Range, vérif checksum MD5 et un WakeLock pour "
                        + "que le download survive l'écran off. Le progrès est diffusé via "
                        + "LocalNotification pour que l'user puisse suivre hors de l'app.",
                },
                dependsOn: ["system.processes"],
                demo: { kind: "route", url: "/options/transcription" },
                files: ["android/app/src/main/java/ca/erplibre/home/WhisperDownloadService.java"],
            },
            {
                id: "transcription.audio-converter",
                label: { en: "Audio converter", fr: "Convertisseur audio" },
                description: {
                    en: "Re-encode recorded audio into whisper-compatible PCM.",
                    fr: "Réencode l'audio enregistré en PCM compatible whisper.",
                },
                status: "stable",
                howItWorks: {
                    en: "Whisper expects 16 kHz mono PCM. Recordings come in as WebM/Opus or "
                        + "AAC; AudioConverter.java uses MediaCodec to decode → resample → "
                        + "encode raw PCM, all on a worker thread. Saves to a tmp file the "
                        + "WhisperPlugin reads, then deletes after transcription.",
                    fr: "Whisper attend du PCM 16 kHz mono. Les enregistrements arrivent en "
                        + "WebM/Opus ou AAC; AudioConverter.java utilise MediaCodec pour decode "
                        + "→ resample → encode PCM brut, tout sur un thread worker. Sauve vers "
                        + "un fichier tmp que WhisperPlugin lit, supprimé après la transcription.",
                },
                demo: NONE_PLUMBING,
                files: ["android/app/src/main/java/ca/erplibre/home/AudioConverter.java"],
            },
            {
                id: "transcription.bridge",
                label: { en: "TS bridge & service", fr: "Bridge TS & service" },
                description: {
                    en: "Run a transcription job from JS, await result.",
                    fr: "Lance une transcription depuis JS, attend le résultat.",
                },
                permissions: ["microphone"],
                status: "stable",
                howItWorks: {
                    en: "TS surface around WhisperPlugin : isEnabled / setEnabled gates the "
                        + "feature, getSelectedModel + isModelDownloaded drive the picker UI, "
                        + "and transcribe(audioPath) returns the inferred text. The service "
                        + "never blocks the UI — long jobs go through the processService queue "
                        + "and emit progress events.",
                    fr: "Surface TS autour de WhisperPlugin : isEnabled / setEnabled protègent "
                        + "la feature, getSelectedModel + isModelDownloaded pilotent l'UI "
                        + "picker, et transcribe(audioPath) retourne le texte inféré. Le service "
                        + "ne bloque jamais l'UI — les jobs longs passent par la queue "
                        + "processService et émettent des events de progression.",
                },
                dependsOn: ["transcription.native"],
                demo: NONE_PLUMBING,
                files: [
                    "src/plugins/whisperPlugin.ts",
                    "src/services/transcriptionService.ts",
                ],
                tests: ["src/__tests__/transcriptionService.test.ts"],
            },
            {
                id: "transcription.options",
                label: { en: "Options panel", fr: "Panel options" },
                description: {
                    en: "Pick a model, monitor download, run a quick test.",
                    fr: "Choisir un modèle, suivre le download, tester.",
                },
                status: "stable",
                howItWorks: {
                    en: "Lists every available whisper model with size + language coverage. "
                        + "Tapping one downloads it (queues a process), shows live progress, and "
                        + "selects it when complete. Includes a 'test transcription' recorder "
                        + "that runs a short clip end-to-end so the user can verify the pipeline "
                        + "works.",
                    fr: "Liste chaque modèle whisper disponible avec taille + langues "
                        + "couvertes. Tap un modèle déclenche le download (queue un process), "
                        + "affiche le progrès live, et le sélectionne au complete. Inclut un "
                        + "enregistreur 'test de transcription' qui run un clip court end-to-end "
                        + "pour vérifier le pipeline.",
                },
                dependsOn: [
                    "transcription.bridge",
                    "transcription.download",
                    "system.processes",
                ],
                demo: { kind: "route", url: "/options/transcription" },
                files: [
                    "src/components/options/transcription/options_transcription_component.ts",
                    "src/components/options/transcription/options_transcription_component.scss",
                ],
            },
        ],
    },
    {
        id: "security",
        label: { en: "🔒 Security", fr: "🔒 Sécurité" },
        description: {
            en: "Biometry, secure storage, dev-mode unlock.",
            fr: "Biométrie, secure storage, déverrouillage dev.",
        },
        demo: { kind: "route", url: "/options" },
        children: [
            {
                id: "security.biometry",
                label: { en: "Biometric auth", fr: "Authentification biométrique" },
                description: {
                    en: "Gate the app behind fingerprint/face.",
                    fr: "Verrouiller l'app derrière empreinte/visage.",
                },
                permissions: ["biometric"],
                status: "stable",
                howItWorks: {
                    en: "@aparajita/capacitor-biometric-auth wraps Android BiometricPrompt. "
                        + "isEnabledByUser is a separate localStorage flag — biometry can be "
                        + "available on the device but not asked for by this user. "
                        + "authenticateForDatabase short-circuits when the OS reports no "
                        + "enrolled biometric, so a fresh device doesn't soft-lock.",
                    fr: "@aparajita/capacitor-biometric-auth enveloppe Android "
                        + "BiometricPrompt. isEnabledByUser est un flag localStorage séparé — la "
                        + "biométrie peut être disponible sur l'appareil mais pas demandée par "
                        + "cet user. authenticateForDatabase short-circuit quand l'OS reporte "
                        + "aucune biométrie enrolée — pas de soft-lock sur device vierge.",
                },
                dependsOn: ["security.secure-storage"],
                demo: { kind: "route", url: "/options" },
                files: [
                    "src/utils/biometryUtils.ts",
                    "src/components/options/options_toggle_biometry_component.ts/options_toggle_biometry_component.ts",
                ],
                tests: ["src/__tests__/biometryUtils.test.ts"],
            },
            {
                id: "security.secure-storage",
                label: { en: "Secure storage", fr: "Secure storage" },
                description: {
                    en: "Encrypted KV (passwords, tokens) in Android keystore.",
                    fr: "KV chiffré (mots de passe, tokens) via keystore Android.",
                },
                howItWorks: {
                    en: "Wraps capacitor-secure-storage-plugin which uses "
                        + "Android Keystore for AES key derivation. Older "
                        + "plain-text creds are migrated on first run via "
                        + "encryptExistingCredentials.ts. Get-on-missing-key "
                        + "throws — callers wrap in try/catch.",
                    fr: "Wrap autour de capacitor-secure-storage-plugin qui "
                        + "utilise Android Keystore pour dériver une clé AES. "
                        + "Les credentials en clair existants sont migrés au "
                        + "premier run via encryptExistingCredentials.ts. "
                        + "Get sur clé manquante throw — wrap try/catch.",
                },
                status: "stable",
                demo: { kind: "options", sectionId: "secure-storage" },
                files: [
                    "src/components/options/secure_storage/options_secure_storage_component.ts",
                    "src/utils/storageUtils.ts",
                    "src/utils/secureFileUtils.ts",
                    "src/utils/cryptoUtils.ts",
                    "src/services/migrations/encryptExistingCredentials.ts",
                ],
                tests: [
                    "src/__tests__/cryptoUtils.test.ts",
                    "src/__tests__/storageUtils.test.ts",
                ],
            },
            {
                id: "security.dev-mode",
                label: { en: "Dev mode unlock", fr: "Déverrouillage dev mode" },
                description: {
                    en: "Tap-counter on device-info row reveals debug screens.",
                    fr: "Tap-counter sur la ligne info appareil débloque les écrans debug.",
                },
                status: "stable",
                howItWorks: {
                    en: "Tap the device-info row 7 times within 3 s to flip a localStorage "
                        + "flag that exposes the developer screens (DB inspector, raw HTTP "
                        + "plugin tester, processes panel). Counter resets on each render so "
                        + "taps must be rapid. No restart required.",
                    fr: "Tap la ligne info-appareil 7 fois en 3 s pour flipper un flag "
                        + "localStorage qui expose les écrans dev (DB inspector, testeur plugin "
                        + "HTTP brut, panel processus). Le compteur reset à chaque render — les "
                        + "taps doivent être rapides. Pas besoin de restart.",
                },
                dependsOn: ["system.device-info"],
                demo: { kind: "options", sectionId: "device-info" },
                files: ["src/components/options/device_info/options_device_info_component.ts"],
            },
        ],
    },
    {
        id: "system",
        label: { en: "📱 System", fr: "📱 Système" },
        description: {
            en: "Power management, device info, network probes.",
            fr: "Gestion énergie, info appareil, sondes réseau.",
        },
        demo: { kind: "route", url: "/options" },
        children: [
            {
                id: "system.keep-awake",
                label: { en: "Keep awake", fr: "Empêcher la veille" },
                description: {
                    en: "FLAG_KEEP_SCREEN_ON to keep deck LCDs lit.",
                    fr: "FLAG_KEEP_SCREEN_ON pour garder les LCD allumées.",
                },
                status: "stable",
                issues: [
                    { en: "Battery drain: scales linearly with screen-on time.",
                      fr: "Batterie : draine proportionnel au temps écran allumé." },
                ],
                howItWorks: {
                    en: "Plugin toggles FLAG_KEEP_SCREEN_ON on the activity "
                        + "window. While set, Android leaves the screen on "
                        + "indefinitely and the USB host stays at full power. "
                        + "Pref persists in localStorage and re-applies on "
                        + "app start.",
                    fr: "Le plugin toggle FLAG_KEEP_SCREEN_ON sur la window "
                        + "de l'activity. Tant qu'il est set, Android garde "
                        + "l'écran on indéfiniment et l'USB host reste à "
                        + "pleine puissance. La préf persiste localStorage "
                        + "et se ré-applique au démarrage.",
                },
                demo: { kind: "options", sectionId: "keep-awake" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/KeepAwakePlugin.java",
                    "src/plugins/keepAwakePlugin.ts",
                    "src/components/options/keep_awake/options_keep_awake_component.ts",
                ],
            },
            {
                id: "system.device-info",
                label: { en: "Device info & IP", fr: "Info appareil & IP" },
                description: {
                    en: "RAM/CPU/IPv4/IPv6, network interfaces.",
                    fr: "RAM/CPU/IPv4/IPv6, interfaces réseau.",
                },
                status: "stable",
                howItWorks: {
                    en: "DeviceStatsPlugin (Java) reads ActivityManager.MemoryInfo for RAM, "
                        + "/proc/stat for CPU, and NetworkInterface.getNetworkInterfaces() for "
                        + "IPv4/IPv6. Refreshes every 2 s while the panel is mounted; the plugin "
                        + "throttles its own JNI calls so a tighter UI tick wouldn't actually "
                        + "fetch faster.",
                    fr: "DeviceStatsPlugin (Java) lit ActivityManager.MemoryInfo pour la RAM, "
                        + "/proc/stat pour le CPU, et NetworkInterface.getNetworkInterfaces() "
                        + "pour IPv4/IPv6. Refresh chaque 2 s pendant que le panel est monté; le "
                        + "plugin throttle ses propres appels JNI — un tick UI plus serré ne "
                        + "fetch pas plus vite.",
                },
                demo: { kind: "options", sectionId: "device-info" },
                files: [
                    "src/components/options/device_info/options_device_info_component.ts",
                    "android/app/src/main/java/ca/erplibre/home/DeviceStatsPlugin.java",
                    "src/plugins/deviceStatsPlugin.ts",
                ],
            },
            {
                id: "system.network-scan",
                label: { en: "LAN network scan", fr: "Scan réseau local" },
                description: {
                    en: "Discover hosts on the local subnet.",
                    fr: "Découvre les hôtes du sous-réseau local.",
                },
                permissions: ["internet"],
                status: "stable",
                howItWorks: {
                    en: "NetworkScanPlugin (Java) walks the local /24 subnet via "
                        + "InetAddress.isReachable on a fixed thread pool. Reports each "
                        + "reachable host (IP + RTT) back through the Capacitor event bus. "
                        + "Cancellable mid-scan; the plugin shuts the pool down on disconnect.",
                    fr: "NetworkScanPlugin (Java) parcourt le sous-réseau /24 local via "
                        + "InetAddress.isReachable sur un pool de threads fixe. Reporte chaque "
                        + "hôte joignable (IP + RTT) via l'event bus Capacitor. Annulable en "
                        + "cours; le plugin shutdown le pool à la déconnexion.",
                },
                demo: NONE_BG,
                files: [
                    "android/app/src/main/java/ca/erplibre/home/NetworkScanPlugin.java",
                    "src/plugins/networkScanPlugin.ts",
                ],
                tests: ["src/__tests__/networkScanPlugin.test.ts"],
            },
            {
                id: "system.permissions",
                label: { en: "Permissions panel", fr: "Panel permissions" },
                description: {
                    en: "Inspect/grant runtime permissions.",
                    fr: "Inspecter/accorder les permissions runtime.",
                },
                status: "stable",
                howItWorks: {
                    en: "Lists the runtime permissions the app declares (camera, microphone, "
                        + "location, biometric, notifications) with their current grant state "
                        + "read via Capacitor's per-plugin checkPermissions(). Tapping a denied "
                        + "perm calls requestPermissions() — the OS dialog handles the rest.",
                    fr: "Liste les permissions runtime déclarées par l'app (caméra, micro, "
                        + "localisation, biométrie, notifications) avec leur état actuel lu via "
                        + "checkPermissions() par plugin Capacitor. Tap sur une perm refusée "
                        + "appelle requestPermissions() — la dialogue OS fait le reste.",
                },
                demo: { kind: "options", sectionId: "permissions" },
                files: ["src/components/options/permissions/options_permissions_component.ts"],
            },
            {
                id: "system.resources",
                label: { en: "Resources (server)", fr: "Ressources (serveur)" },
                description: {
                    en: "Read RAM/CPU/disk of a remote server over SSH.",
                    fr: "Lit RAM/CPU/disk d'un serveur distant via SSH.",
                },
                permissions: ["internet"],
                dependsOn: ["deployment.ssh"],
                status: "stable",
                howItWorks: {
                    en: "Pulls free/df/uptime/sensors/who/etc over SSH against a configured "
                        + "server, then runs serverResourceParsers (small dedicated parsers per "
                        + "command — fmtKb, parseMem, parseDisk, parseNet…) to turn raw output "
                        + "into structured rows the UI renders as cards + bars.",
                    fr: "Tire free/df/uptime/sensors/who/etc en SSH vers un serveur configuré, "
                        + "puis run serverResourceParsers (petits parsers dédiés par commande — "
                        + "fmtKb, parseMem, parseDisk, parseNet…) qui transforment la sortie "
                        + "brute en lignes structurées rendues en cartes + barres.",
                },
                demo: { kind: "route", url: "/options/resources" },
                files: [
                    "src/components/options/resources/options_resources_component.ts",
                    "src/components/options/resources/options_resources_component.scss",
                    "src/components/servers/resources/servers_resources_component.ts",
                    "src/utils/serverResourceParsers.ts",
                ],
                tests: ["src/__tests__/serverResourceParsers.test.ts"],
            },
            {
                id: "system.processes",
                label: { en: "Processes (long jobs)", fr: "Processus (tâches longues)" },
                description: {
                    en: "Track and inspect background jobs.",
                    fr: "Suivre et inspecter les tâches d'arrière-plan.",
                },
                status: "stable",
                howItWorks: {
                    en: "Long-running tasks (transcription, model download, deployment) are "
                        + "persisted as rows in the processes table with progress, debug_log and "
                        + "result columns. The processes panel subscribes via ProcessService and "
                        + "re-renders on each notify; ring-buffer 50 trimmed on each append to "
                        + "keep the DB small.",
                    fr: "Les tâches longues (transcription, download de modèle, déploiement) "
                        + "sont persistées en lignes de la table processes avec colonnes "
                        + "progress, debug_log et result. Le panel processes s'abonne via "
                        + "ProcessService et re-rend à chaque notify; ring-buffer 50 trimmé à "
                        + "chaque append pour garder la DB petite.",
                },
                demo: { kind: "route", url: "/options/processes" },
                files: [
                    "src/components/options/processes/options_processes_component.ts",
                    "src/services/processService.ts",
                    "src/models/process.ts",
                    "src/services/migrations/addProcessesTable.ts",
                    "src/services/migrations/addProcessDebugLogColumn.ts",
                    "src/services/migrations/addProcessResultColumn.ts",
                ],
                tests: ["src/__tests__/processService.test.ts"],
            },
        ],
    },
    {
        id: "deployment",
        label: { en: "🚀 Deployment", fr: "🚀 Déploiement" },
        description: {
            en: "Provision and update Odoo servers from the phone.",
            fr: "Provisionner et mettre à jour les serveurs Odoo depuis le tel.",
        },
        demo: { kind: "route", url: "/applications" },
        children: [
            {
                id: "deployment.service",
                label: { en: "Deployment service", fr: "Service de déploiement" },
                description: {
                    en: "Multi-step pipeline (SSH, scp, restart) with progress.",
                    fr: "Pipeline multi-étapes (SSH, scp, restart) avec progression.",
                },
                status: "stable",
                permissions: ["internet"],
                dependsOn: [
                    "deployment.ssh",
                    "system.processes",
                ],
                howItWorks: {
                    en: "State machine of named steps (validateSsh, scpPayload, runScript, "
                        + "restart, healthCheck …). Each step is idempotent and can be retried "
                        + "from any point. Progress and per-step status persist as rows under "
                        + "processes (system.processes), so closing the app mid-deploy doesn't "
                        + "lose the trail.",
                    fr: "Machine d'états avec steps nommées (validateSsh, scpPayload, "
                        + "runScript, restart, healthCheck …). Chaque step est idempotente et "
                        + "retriable depuis n'importe quel point. Progrès et statut par step "
                        + "persistés en lignes processes (system.processes), donc fermer l'app "
                        + "en plein deploy ne perd pas la trace.",
                },
                demo: NONE_BG,
                files: ["src/services/deploymentService.ts"],
                tests: ["src/__tests__/deploymentService.test.ts"],
            },
            {
                id: "deployment.ssh",
                label: { en: "SSH plugin", fr: "Plugin SSH" },
                description: {
                    en: "JSch-backed SSH exec/sftp.",
                    fr: "SSH exec/sftp basé sur JSch.",
                },
                permissions: ["internet"],
                status: "stable",
                howItWorks: {
                    en: "SshPlugin wraps JSch (Java SSH library). exec() runs a one-shot "
                        + "command and returns stdout+stderr+exitCode; sftpPut/sftpGet stream a "
                        + "file with chunked progress events. Auth is keyboard-interactive or "
                        + "public-key (PEM stored in secure-storage).",
                    fr: "SshPlugin enveloppe JSch (lib SSH Java). exec() lance une commande "
                        + "one-shot et retourne stdout+stderr+exitCode; sftpPut/sftpGet "
                        + "streament un fichier avec events de progrès par chunk. Auth "
                        + "clavier-interactif ou clé publique (PEM stocké en secure-storage).",
                },
                demo: NONE_BG,
                files: [
                    "android/app/src/main/java/ca/erplibre/home/SshPlugin.java",
                    "src/plugins/sshPlugin.ts",
                ],
            },
            {
                id: "deployment.raw-http",
                label: { en: "Raw HTTP plugin", fr: "Plugin HTTP brut" },
                description: {
                    en: "TCP-level HTTP for self-signed Odoo endpoints.",
                    fr: "HTTP au niveau TCP pour endpoints Odoo self-signed.",
                },
                permissions: ["internet"],
                status: "stable",
                howItWorks: {
                    en: "For Odoo endpoints behind self-signed TLS that the Android system "
                        + "trust store rejects, RawHttpPlugin uses Java's HttpsURLConnection "
                        + "with a custom TrustManager that accepts the user-provided cert. Used "
                        + "only for healthchecks and pin-then-trust workflows — main sync still "
                        + "uses the WebView's regular fetch.",
                    fr: "Pour les endpoints Odoo derrière TLS self-signed que le trust store "
                        + "Android rejette, RawHttpPlugin utilise HttpsURLConnection Java avec "
                        + "un TrustManager custom qui accepte le cert fourni par l'user. Utilisé "
                        + "seulement pour healthchecks et workflows pin-then-trust — la sync "
                        + "principale passe par le fetch normal.",
                },
                demo: NONE_BG,
                files: [
                    "android/app/src/main/java/ca/erplibre/home/RawHttpPlugin.java",
                    "src/plugins/rawHttpPlugin.ts",
                ],
            },
            {
                id: "deployment.deploy-ui",
                label: { en: "Deploy UI", fr: "UI déploiement" },
                description: {
                    en: "Live deploy log with retry-from-step.",
                    fr: "Log déploiement live avec retry-from-step.",
                },
                status: "stable",
                howItWorks: {
                    en: "Live deploy view bound to the Process row driving the deployment. "
                        + "Each step renders as a row with status icon, elapsed time, and "
                        + "toggleable debug log. Failed steps show a 'retry from here' button "
                        + "that re-enters the state machine at that step.",
                    fr: "Vue deploy live bindée à la ligne Process qui pilote le déploiement. "
                        + "Chaque step rendue en ligne avec icône statut, temps écoulé, et debug "
                        + "log toggleable. Les steps en échec affichent un bouton 'retry from "
                        + "here' qui rentre dans la state machine à cette step.",
                },
                dependsOn: ["deployment.service"],
                demo: { kind: "route", url: "/applications" },
                files: [
                    "src/components/servers/deploy/servers_deploy_component.ts",
                    "src/components/servers/deploy/servers_deploy_component.scss",
                ],
            },
            {
                id: "deployment.servers",
                label: { en: "Server CRUD", fr: "CRUD serveurs" },
                status: "stable",
                tests: ["src/__tests__/serverService.test.ts"],
                description: {
                    en: "Create/edit/delete servers and their workspaces.",
                    fr: "Créer/éditer/supprimer serveurs et workspaces.",
                },
                howItWorks: {
                    en: "Each Server has its own workspaces (db_url + ssh creds + odoo "
                        + "version). Stored in the servers table with the keys-of-secrets "
                        + "pattern: only references to secure-storage keys, not the values. "
                        + "Workspace switching pivots the active context for SSH and Odoo sync "
                        + "without restarting.",
                    fr: "Chaque Server a ses workspaces (db_url + creds SSH + version odoo). "
                        + "Stocké en table servers avec le pattern keys-of-secrets : seulement "
                        + "des références aux clés secure-storage, pas les valeurs. Switcher de "
                        + "workspace pivote le contexte actif pour SSH et sync Odoo sans "
                        + "redémarrer.",
                },
                dependsOn: ["security.secure-storage"],
                demo: { kind: "route", url: "/applications" },
                files: [
                    "src/components/servers/add/servers_add_component.ts",
                    "src/components/servers/edit/servers_edit_component.ts",
                    "src/components/servers/item/servers_item_component.ts",
                    "src/components/servers/settings/servers_settings_component.ts",
                    "src/components/servers/workspace/servers_workspace_component.ts",
                    "src/services/serverService.ts",
                    "src/models/server.ts",
                    "src/models/workspace.ts",
                    "src/services/migrations/addServersTable.ts",
                    "src/services/migrations/addServerWorkspacesTable.ts",
                ],
            },
            {
                id: "deployment.applications",
                label: { en: "Odoo apps CRUD", fr: "CRUD applications Odoo" },
                status: "stable",
                tests: ["src/__tests__/appService.test.ts"],
                description: {
                    en: "Manage Odoo instances (URL, version, sync flags).",
                    fr: "Gérer les instances Odoo (URL, version, flags sync).",
                },
                howItWorks: {
                    en: "An Application links a Server to a specific Odoo URL + database + "
                        + "version. Sync flags (autoSync, pollIntervalMinutes, ntfyTopic, "
                        + "selectedSyncConfigIds) live here so multiple instances on the same "
                        + "server stay independent. addOdooVersionToApplications migration "
                        + "backfills the version column.",
                    fr: "Une Application lie un Server à une URL Odoo + database + version "
                        + "précise. Les flags sync (autoSync, pollIntervalMinutes, ntfyTopic, "
                        + "selectedSyncConfigIds) vivent ici pour que plusieurs instances sur le "
                        + "même serveur restent indépendantes. Migration "
                        + "addOdooVersionToApplications backfille la colonne version.",
                },
                dependsOn: ["deployment.servers"],
                demo: { kind: "route", url: "/applications" },
                files: [
                    "src/components/applications/applications_component.ts",
                    "src/components/applications/add/applications_add_component.ts",
                    "src/components/applications/edit/applications_edit_component.ts",
                    "src/components/applications/item/applications_item_component.ts",
                    "src/services/appService.ts",
                    "src/models/application.ts",
                    "src/services/migrations/addApplicationSyncFields.ts",
                    "src/services/migrations/addOdooVersionToApplications.ts",
                ],
            },
        ],
    },
    {
        id: "data",
        label: { en: "🗄️ Data / DB", fr: "🗄️ Données / DB" },
        description: {
            en: "SQLite store, migrations, debug viewers.",
            fr: "Stockage SQLite, migrations, viewers debug.",
        },
        demo: { kind: "route", url: "/options/database" },
        children: [
            {
                id: "data.database",
                label: { en: "DB service (SQLite)", fr: "Service DB (SQLite)" },
                description: {
                    en: "Single connection wrapper, encrypted at rest.",
                    fr: "Wrapper connexion unique, chiffré au repos.",
                },
                status: "stable",
                howItWorks: {
                    en: "Single SQLite connection wrapper around @capacitor-community/sqlite. "
                        + "Encryption key is generated on first init and stored in "
                        + "secure-storage; subsequent boots open the encrypted DB with that key. "
                        + "All other services receive the DatabaseService instance via app.ts — "
                        + "no duplicate connections.",
                    fr: "Wrapper de connexion SQLite unique autour de "
                        + "@capacitor-community/sqlite. La clé de chiffrement est générée à la "
                        + "1re init et stockée en secure-storage; les boots suivants ouvrent la "
                        + "DB chiffrée avec cette clé. Tous les autres services reçoivent "
                        + "l'instance DatabaseService via app.ts — pas de connexions dupliquées.",
                },
                demo: NONE_PLUMBING,
                files: ["src/services/databaseService.ts"],
                tests: ["src/__tests__/databaseService.test.ts"],
            },
            {
                id: "data.migrations",
                label: { en: "Migration runner", fr: "Runner de migrations" },
                description: {
                    en: "Versioned schema upgrades on app launch.",
                    fr: "Migrations de schéma versionnées au démarrage.",
                },
                status: "stable",
                howItWorks: {
                    en: "MigrationService runs an ordered list of (version, fn) at boot. "
                        + "Current version is read from a meta row; each fn that hasn't yet run "
                        + "is invoked, then the version is bumped after the last success. "
                        + "Failure aborts the boot with a popup (migrationPopup) so the user has "
                        + "explicit context.",
                    fr: "MigrationService run une liste ordonnée de (version, fn) au boot. La "
                        + "version courante est lue depuis une ligne meta; chaque fn pas encore "
                        + "exécutée est invoquée, puis la version est bumpée après le dernier "
                        + "succès. Un échec abort le boot avec un popup (migrationPopup) pour "
                        + "que l'user ait le contexte explicite.",
                },
                demo: NONE_BG,
                files: [
                    "src/services/migrationService.ts",
                    "src/services/dataMigration.ts",
                ],
                tests: [
                    "src/__tests__/migrationService.test.ts",
                    "src/__tests__/dataMigration.test.ts",
                    "src/__tests__/migrationPopup.test.ts",
                ],
            },
            {
                id: "data.inspector",
                label: { en: "DB inspector", fr: "Inspecteur DB" },
                description: {
                    en: "Browse tables, run SQL, see DB size.",
                    fr: "Parcourir tables, exécuter SQL, voir la taille DB.",
                },
                status: "stable",
                howItWorks: {
                    en: "Read-only panel listing every table with row count and on-disk size, "
                        + "plus a free-form SQL prompt that runs SELECT-only queries (rejected "
                        + "with an error otherwise) against the active DatabaseService. Useful "
                        + "for diagnosing sync conflicts and migration-history rows on device.",
                    fr: "Panel read-only listant chaque table avec row count et taille sur "
                        + "disque, plus un prompt SQL libre qui run uniquement des requêtes "
                        + "SELECT (rejet avec erreur sinon) sur la DatabaseService active. Utile "
                        + "pour diagnostiquer les conflits sync et les lignes migration-history "
                        + "sur device.",
                },
                demo: { kind: "route", url: "/options/database" },
                files: [
                    "src/components/options/database/options_database_component.ts",
                    "src/components/options/sqlite_tables/options_sqlite_tables_component.ts",
                    "src/components/options/db_size/options_db_size_component.ts",
                ],
            },
            {
                id: "data.migration-history",
                label: { en: "Migration history", fr: "Historique migrations" },
                description: {
                    en: "List of applied migrations with timestamps.",
                    fr: "Liste des migrations appliquées avec timestamps.",
                },
                status: "stable",
                howItWorks: {
                    en: "Lists every migration that ran on the local DB with its timestamp and "
                        + "result counts. Read-only — populated by MigrationService as each step "
                        + "runs at boot. Surfaces silent migrations the user didn't notice (e.g. "
                        + "backfills for sync columns).",
                    fr: "Liste chaque migration qui a tourné sur la DB locale avec son "
                        + "timestamp et ses compteurs de résultat. Read-only — peuplé par "
                        + "MigrationService au boot pendant que chaque step tourne. Surfacie les "
                        + "migrations silencieuses (ex. backfills pour les colonnes sync).",
                },
                dependsOn: ["data.migrations"],
                demo: { kind: "options", sectionId: "migration-history" },
                files: ["src/components/options/migration_history/options_migration_history_component.ts"],
            },
            {
                id: "data.clear-cache",
                label: { en: "Clear cache", fr: "Vider le cache" },
                description: {
                    en: "Reset the app's local DB and bundles.",
                    fr: "Réinitialise la DB locale et les bundles.",
                },
                status: "stable",
                howItWorks: {
                    en: "Drops every SQLite table and unlinks the editable-overlay directory, "
                        + "then asks the user to relaunch. Bundle tarballs in src/public/repos/ "
                        + "are not touched — they ship with the APK and can't change. Behind a "
                        + "typed-confirmation dialog because there's no undo.",
                    fr: "Drop chaque table SQLite et délie le dossier overlay éditable, puis "
                        + "demande à l'user de relancer. Les tarballs bundles dans "
                        + "src/public/repos/ ne sont pas touchés — ils sont livrés avec l'APK et "
                        + "ne peuvent pas changer. Derrière une dialogue de confirmation tapée "
                        + "parce qu'il n'y a pas d'undo.",
                },
                dependsOn: ["repos.edit"],
                demo: { kind: "options", sectionId: "clear-cache" },
                files: ["src/components/options/clear_cache/options_clear_cache_component.ts"],
            },
        ],
    },
    {
        id: "ui",
        label: { en: "🎨 UI / UX", fr: "🎨 UI / UX" },
        description: {
            en: "Routing, theming, reminders, shared components.",
            fr: "Routing, thème, rappels, composants partagés.",
        },
        children: [
            {
                id: "ui.router",
                label: { en: "Router & navigation", fr: "Router & navigation" },
                status: "stable",
                tests: ["src/__tests__/router.test.ts"],
                description: {
                    en: "Hash-based router with route table and navbar.",
                    fr: "Router à hash avec table de routes et navbar.",
                },
                howItWorks: {
                    en: "SimpleRouter is a tiny home-grown router (<200 lines) that maps "
                        + "location.pathname to a component class. Supports dynamic segments "
                        + "(/note/:id) parsed by getRouteParams, and event-bus navigation "
                        + "(Events.ROUTER_NAVIGATION) so non-UI services can redirect.",
                    fr: "SimpleRouter est un mini-routeur maison (<200 lignes) qui mappe "
                        + "location.pathname à une classe de composant. Supporte les segments "
                        + "dynamiques (/note/:id) parsés par getRouteParams, et la navigation "
                        + "par event-bus (Events.ROUTER_NAVIGATION) pour que les services non-UI "
                        + "puissent rediriger.",
                },
                demo: NONE_PLUMBING,
                files: [
                    "src/js/router.ts",
                    "src/js/routes.ts",
                    "src/components/navbar/navbar_component.ts",
                    "src/components/navbar/item/navbar_item_component.ts",
                ],
            },
            {
                id: "ui.theme",
                label: { en: "Theme & graphic prefs", fr: "Thème & préférences graphiques" },
                status: "stable",
                tests: ["src/__tests__/graphicPrefs.test.ts"],
                description: {
                    en: "Colours, fonts, motion preferences stored in DB.",
                    fr: "Couleurs, polices, motion stockées en DB.",
                },
                howItWorks: {
                    en: "GraphicPrefs reads a small set of localStorage keys (color theme, "
                        + "font scale, density) and applies them as CSS custom properties on "
                        + "documentElement at boot. Writers update both localStorage and the "
                        + "live var() so the change is instant — no reload required.",
                    fr: "GraphicPrefs lit un petit set de clés localStorage (color theme, font "
                        + "scale, density) et les applique comme propriétés CSS sur "
                        + "documentElement au boot. Les writers updatent à la fois localStorage "
                        + "et la var() live — le changement est instant, pas de reload.",
                },
                demo: { kind: "options", sectionId: "graphic" },
                files: [
                    "src/components/options/graphic/options_graphic_component.ts",
                    "src/services/migrations/addUserGraphicPrefs.ts",
                    "src/models/graphicPrefs.ts",
                    "src/css/vars.scss",
                    "src/css/style.scss",
                ],
            },
            {
                id: "ui.reminders",
                label: { en: "Reminders", fr: "Rappels" },
                description: {
                    en: "Local notifications scheduled per note.",
                    fr: "Notifications locales planifiées par note.",
                },
                status: "stable",
                permissions: ["notifications"],
                howItWorks: {
                    en: "Reminders schedule a LocalNotification at a future timestamp via "
                        + "@capacitor/local-notifications. addReminderCreatedAt migration adds "
                        + "the column for ordering. Cleared from the OS notification tray as "
                        + "soon as the user opens the matching note.",
                    fr: "Les rappels schedulent une LocalNotification à un timestamp futur via "
                        + "@capacitor/local-notifications. La migration addReminderCreatedAt "
                        + "ajoute la colonne pour l'ordre. Effacé de la barre OS dès que l'user "
                        + "ouvre la note correspondante.",
                },
                dependsOn: ["notes.service"],
                demo: { kind: "options", sectionId: "reminders" },
                files: [
                    "src/components/options/reminders/options_reminders_component.ts",
                    "src/services/reminderService.ts",
                    "src/models/reminder.ts",
                    "src/services/migrations/addReminderCreatedAt.ts",
                ],
                tests: ["src/__tests__/reminderService.test.ts"],
            },
            {
                id: "ui.shared-components",
                label: { en: "Shared components", fr: "Composants partagés" },
                description: {
                    en: "Heading, content shell, root layout.",
                    fr: "Heading, coquille content, layout root.",
                },
                status: "stable",
                howItWorks: {
                    en: "HeadingComponent renders the top safe-area + title bar; "
                        + "ContentComponent is the scrollable shell every page mounts into; "
                        + "RootComponent is the single Owl root that hosts the SimpleRouter. "
                        + "Pages don't import these directly — the route resolver wraps them "
                        + "automatically.",
                    fr: "HeadingComponent rend la safe-area du haut + la barre de titre; "
                        + "ContentComponent est la coquille scrollable où chaque page se monte; "
                        + "RootComponent est l'unique root Owl qui héberge le SimpleRouter. Les "
                        + "pages n'importent pas ces composants — le resolver de route les "
                        + "enveloppe automatiquement.",
                },
                demo: NONE_PLUMBING,
                files: [
                    "src/components/heading/heading_component.ts",
                    "src/components/content/content_component.ts",
                    "src/components/root/root_component.ts",
                ],
            },
            {
                id: "ui.owl-aot",
                label: { en: "Owl AOT bridge", fr: "Bridge Owl AOT" },
                description: {
                    en: "Pre-compile templates at build for fast startup.",
                    fr: "Pré-compile les templates au build pour boot rapide.",
                },
                howItWorks: {
                    en: "owl-aot.ts intercepts every xml`...` literal at build "
                        + "time and replaces it with a pre-compiled render "
                        + "function (no runtime template parsing). The "
                        + "precompiled functions land in a single chunk "
                        + "(`owl-templates`) so the WebView can parse the "
                        + "main entry and the templates in parallel.",
                    fr: "owl-aot.ts intercepte chaque xml`...` au build et "
                        + "remplace par une fonction render pré-compilée (pas "
                        + "de parsing template au runtime). Les fonctions "
                        + "atterrissent dans un chunk unique "
                        + "(`owl-templates`) pour parsing parallèle de "
                        + "l'entry et des templates par le WebView.",
                },
                status: "stable",
                demo: NONE_PLUMBING,
                files: [
                    "src/js/owl-aot.ts",
                    "src/js/enhancedComponent.ts",
                ],
            },
            {
                id: "ui.errors",
                label: { en: "Error handling", fr: "Gestion d'erreurs" },
                description: {
                    en: "Centralised error labels and helpers.",
                    fr: "Libellés d'erreurs et helpers centralisés.",
                },
                status: "stable",
                howItWorks: {
                    en: "Bilingual error labels (errorMessages.ts) and typed Error subclasses "
                        + "(errors.ts) shared across the app — UndefinedNoteList, NoNoteMatch, "
                        + "NoteKeyNotFound, etc. Catch-blocks throw the typed variant; the UI "
                        + "looks up the matching message instead of hard-coding strings.",
                    fr: "Libellés d'erreur bilingues (errorMessages.ts) et sous-classes Error "
                        + "typées (errors.ts) partagées dans l'app — UndefinedNoteList, "
                        + "NoNoteMatch, NoteKeyNotFound, etc. Les catch-blocks throw la variante "
                        + "typée; l'UI lookup le message qui matche au lieu de hardcoder.",
                },
                demo: NONE_PLUMBING,
                files: [
                    "src/js/errors.ts",
                    "src/constants/errorMessages.ts",
                ],
            },
        ],
    },
    {
        id: "meta",
        label: { en: "ℹ️ Meta", fr: "ℹ️ Méta" },
        description: {
            en: "Home page, options shell, build metadata.",
            fr: "Accueil, coquille options, métadonnées de build.",
        },
        children: [
            {
                id: "meta.home",
                label: { en: "Home page + uptime", fr: "Accueil + uptime" },
                description: {
                    en: "Stats, quick notes, live uptime counter.",
                    fr: "Stats, accès rapide notes, compteur uptime live.",
                },
                howItWorks: {
                    en: "STARTUP_AT is captured at module load. The uptime "
                        + "counter ticks every 1 s while under one minute "
                        + "(seconds visible) and switches to a 60 s tick "
                        + "afterwards (seconds dropped) — no point waking "
                        + "the WebView 60×/min for invisible churn.",
                    fr: "STARTUP_AT est capturé au load du module. Le "
                        + "compteur uptime tick chaque 1 s sous une minute "
                        + "(secondes visibles) et passe à un tick 60 s "
                        + "ensuite (secondes droppées) — inutile de réveiller "
                        + "le WebView 60×/min pour rien.",
                },
                status: "stable",
                demo: { kind: "route", url: "/" },
                files: [
                    "src/components/home/home_component.ts",
                    "src/components/home/home_component.scss",
                ],
            },
            {
                id: "meta.changelog",
                label: { en: "Changelog", fr: "Changelog" },
                description: {
                    en: "Show recent app updates.",
                    fr: "Affiche les mises à jour récentes.",
                },
                status: "stable",
                howItWorks: {
                    en: "Reads CHANGELOG.md from the bundle at boot, parses the H2 sections by "
                        + "date, and renders the most recent entries in a popover. No network — "
                        + "what's there is what shipped in the APK. Useful for users on field "
                        + "devices that can't easily check the website.",
                    fr: "Lit CHANGELOG.md depuis le bundle au boot, parse les sections H2 par "
                        + "date, et rend les entrées les plus récentes dans un popover. Pas de "
                        + "réseau — ce qui est là est ce qui a été livré dans l'APK. Utile pour "
                        + "les users sur appareils terrain qui ne peuvent pas checker le site "
                        + "facilement.",
                },
                demo: { kind: "options", sectionId: "changelog" },
                files: ["src/components/options/changelog/options_changelog_component.ts"],
            },
            {
                id: "meta.erplibre",
                label: { en: "Open ERPLibre source", fr: "Ouvrir source ERPLibre" },
                description: {
                    en: "Browse the workspace bundle (full source tree).",
                    fr: "Parcourir le bundle workspace (arbre source complet).",
                },
                status: "stable",
                howItWorks: {
                    en: "Same browser as code.viewer, opened on the workspace bundle "
                        + "(target=erplibre instead of target=mobile). Lets a curious user "
                        + "explore the full ERPLibre source tree (Odoo addons + scripts) without "
                        + "leaving the app — read-only, no edit overlay.",
                    fr: "Même browser que code.viewer, ouvert sur le bundle workspace "
                        + "(target=erplibre au lieu de target=mobile). Permet à un user curieux "
                        + "d'explorer l'arbre source ERPLibre complet (addons Odoo + scripts) "
                        + "sans quitter l'app — read-only, pas d'overlay d'édition.",
                },
                demo: { kind: "route", url: "/options/erplibre" },
                files: [
                    "src/components/options/erplibre/options_erplibre_component.ts",
                    "src/components/options/erplibre/options_erplibre_component.scss",
                ],
            },
            {
                id: "meta.feature-catalog",
                label: { en: "Feature catalogue", fr: "Catalogue fonctionnalités" },
                description: {
                    en: "This very tree — bilingual feature map of the app.",
                    fr: "Cet arbre — carte bilingue des fonctionnalités de l'app.",
                },
                howItWorks: {
                    en: "FEATURE_TREE in src/data/featureCatalog.ts is the "
                        + "source of truth. The /options/features page renders "
                        + "it as a recursive tree component with search, "
                        + "deep-link, and per-node detail. A vitest suite "
                        + "enforces uniqueness, file existence, dependsOn "
                        + "validity, and orphan detection (every src/ file "
                        + "must be in some feature or allow-listed).",
                    fr: "FEATURE_TREE dans src/data/featureCatalog.ts est la "
                        + "source de vérité. /options/features rend l'arbre "
                        + "via un composant récursif (recherche, deep-link, "
                        + "détail par noeud). Suite vitest vérifie unicité, "
                        + "existence des fichiers, validité dependsOn, et "
                        + "détection d'orphelins.",
                },
                status: "experimental",
                demo: { kind: "route", url: "/options/features" },
                files: [
                    "src/components/options/features/options_features_component.ts",
                    "src/components/options/features/options_features_component.scss",
                    "src/components/options/features/featureViewUtils.ts",
                    "src/data/featureCatalog.ts",
                    "src/utils/featureSection.ts",
                ],
                tests: [
                    "src/__tests__/featureCatalog.test.ts",
                    "src/__tests__/featureViewUtils.test.ts",
                    "src/__tests__/permissionsAudit.test.ts",
                ],
            },
            {
                id: "meta.options",
                label: { en: "Options shell", fr: "Coquille Options" },
                description: {
                    en: "Parent component listing every options sub-feature.",
                    fr: "Composant parent listant chaque sous-option.",
                },
                status: "stable",
                howItWorks: {
                    en: "Routes-style options listing using URL hash sections "
                        + "(/options#streamdeck) so deep-links from the catalogue, the changelog "
                        + "or external sources can scroll the page to the right row. Each "
                        + "sub-feature mounts on demand to keep the initial render cheap.",
                    fr: "Liste options style routes utilisant les sections hash URL "
                        + "(/options#streamdeck) — les deep-links depuis le catalogue, le "
                        + "changelog ou des sources externes peuvent scroller la page sur la "
                        + "bonne ligne. Chaque sous-feature monte à la demande pour garder le "
                        + "render initial léger.",
                },
                demo: { kind: "route", url: "/options" },
                files: [
                    "src/components/options/options_component.ts",
                    "src/components/options/options_component.scss",
                ],
            },
            {
                id: "meta.app-bootstrap",
                label: { en: "App bootstrap", fr: "Bootstrap app" },
                description: {
                    en: "Wire env, services and mount root component.",
                    fr: "Configure env, services et monte le composant root.",
                },
                status: "stable",
                howItWorks: {
                    en: "app.ts is the Vite entry: reads VITE_* env, instantiates "
                        + "DatabaseService → runs migrations → spins up syncService, appService, "
                        + "intentService, notificationService, and finally mounts RootComponent "
                        + "on #app. Order matters because some services subscribe to events "
                        + "emitted during others' init.",
                    fr: "app.ts est l'entrée Vite : lit les VITE_* env, instancie "
                        + "DatabaseService → run les migrations → instancie syncService, "
                        + "appService, intentService, notificationService, puis monte "
                        + "RootComponent sur #app. L'ordre compte car certains services "
                        + "s'abonnent à des events émis pendant l'init d'autres.",
                },
                demo: NONE_PLUMBING,
                files: [
                    "src/js/app.ts",
                    "src/js/helpers.ts",
                ],
            },
            {
                id: "meta.build-id",
                label: { en: "Build ID", fr: "Build ID" },
                description: {
                    en: "Per-build hash + timestamp for crash triage.",
                    fr: "Hash + timestamp par build pour le triage.",
                },
                status: "stable",
                howItWorks: {
                    en: "Vite plugin generates a (gitShortSha + timestamp) on every build and "
                        + "writes it to src/public/build_id.json. Surfaced in Options → Device "
                        + "info so a bug report from the field always carries the exact APK "
                        + "build, not a vague version.",
                    fr: "Plugin Vite génère un (gitShortSha + timestamp) à chaque build et "
                        + "l'écrit dans src/public/build_id.json. Surfacé dans Options → Info "
                        + "appareil pour qu'un rapport de bug du terrain transporte toujours le "
                        + "build APK exact, pas une version vague.",
                },
                demo: NONE_PLUMBING,
                files: ["src/public/build_id.json"],
            },
        ],
    },
];
