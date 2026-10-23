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
                        label: { en: "Photo / Image", fr: "Photo / Image" },
                        description: {
                            en: "Capture (camera) or pick (gallery), kept distinct.",
                            fr: "Capturer (caméra) ou choisir (galerie), distincts.",
                        },
                        permissions: ["camera"],
                        status: "stable",
                        howItWorks: {
                            en: "Both flows produce a `photo`-typed entry, but the "
                                + "factory tags it with params.source — \"camera\" for "
                                + "the bottom-bar 📷 Photo button (CameraSource.Camera, "
                                + "needs the camera permission), \"gallery\" for the "
                                + "🖼️ Image button (CameraSource.Photos, no runtime "
                                + "permission — the system photo picker handles "
                                + "consent). On re-edit, the entry component reads "
                                + "the source and renders the matching button so the "
                                + "user re-opens the same surface they originally "
                                + "used. Path is the Capacitor file URI; the WebView "
                                + "loads it via Capacitor.convertFileSrc.",
                            fr: "Les deux flux produisent une entrée de type `photo`, "
                                + "mais le factory marque params.source — \"camera\" "
                                + "pour le bouton 📷 Photo de la barre du bas "
                                + "(CameraSource.Camera, requiert la permission "
                                + "caméra), \"gallery\" pour le bouton 🖼️ Image "
                                + "(CameraSource.Photos, pas de permission — le "
                                + "sélecteur photo système gère le consentement). À "
                                + "la ré-édition, le composant entry lit la source "
                                + "et affiche le bon bouton, pour que l'utilisateur "
                                + "rouvre la même surface qu'à la création. Path = "
                                + "URI Capacitor; le WebView charge via "
                                + "Capacitor.convertFileSrc.",
                        },
                        dependsOn: ["notes.entries.framework"],
                        demo: { kind: "route", url: "/note/demo" },
                        files: [
                            "src/components/note_entry/photo/note_entry_photo_component.ts",
                            "src/services/note/noteEntrySubservice.ts",
                        ],
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
                        tests: [
                            "src/__tests__/videoThumbnailUtils.test.ts",
                            "src/__tests__/migrateVideoThumbnails.test.ts",
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
                tests: ["src/__tests__/migrations.test.ts"],
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
                        + "batched on a single JNI call per deck. KeyEventGate holds "
                        + "keyChanged until the page's key handler calls "
                        + "keyListenerReady (at launch and after each page load): "
                        + "the last 16 events at most, those older than 10 s "
                        + "dropped, the rest delivered in arrival order. "
                        + "FeatureReads probes the control pipe at open with "
                        + "the firmware report (250 ms, one retry): a deck "
                        + "that answers neither opens with controlPipeOk "
                        + "false and its usual deckId (the USB serial "
                        + "string, read without EP0), and "
                        + "brightness and reset refused at once but for one "
                        + "250 ms try every 5 s (ControlPipe); the first "
                        + "control request that goes through sets it back "
                        + "to true.",
                    fr: "Plugin Capacitor (Java) qui enveloppe le stack USB host. DeckRegistry "
                        + "garde une DeckSession par appareil branché; DeckSpec porte product id "
                        + "→ nb touches, taille image, version transport. La surface bridge est "
                        + "JSON sur le pipe Capacitor JS↔Java; les frames binaires passent en "
                        + "base64 batchées en un seul appel JNI par deck. KeyEventGate "
                        + "retient keyChanged jusqu'à ce que le gestionnaire de "
                        + "touches de la page appelle keyListenerReady (au lancement "
                        + "et après chaque chargement de page) : 16 événements au "
                        + "plus, ceux de plus de 10 s écartés, les autres livrés "
                        + "dans leur ordre d'arrivée. FeatureReads sonde le "
                        + "canal de contrôle à l'ouverture avec le rapport "
                        + "firmware (250 ms, un nouvel essai) : un deck qui "
                        + "ne répond à aucun s'ouvre avec controlPipeOk faux, "
                        + "son deckId habituel (la chaîne de série USB, lue "
                        + "sans EP0), et luminosité "
                        + "et reset refusés aussitôt sauf un essai de 250 ms "
                        + "toutes les 5 s (ControlPipe) ; la première requête "
                        + "de contrôle qui passe le remet à vrai.",
                },
                demo: NONE_PLUMBING,
                files: [
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/StreamDeckPlugin.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/DeckSession.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/WorkerShutdown.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/UsbCallGate.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/CloseOnce.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/ParallelClose.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/DeckSpec.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/DeckRegistry.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/KeyEventGate.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/FeatureReads.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/ControlPipe.java",
                ],
                tests: [
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/FeatureReadsTest.java",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/ControlPipeTest.java",
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
                        + "crash. Key 0 always navigates to a fresh /note/<id>; "
                        + "keys 1-3 are painted only while a NoteComponent is "
                        + "mounted (notified via the STREAMDECK_NOTE_PAGE_ACTIVE "
                        + "bus event) and fire STREAMDECK_ADD_VIDEO/AUDIO/"
                        + "LOCATION events that the note re-uses to add an "
                        + "entry. On visibilitychange:hidden each deck dims to "
                        + "0 %; a brief hide only restores brightness and "
                        + "repaints. After a hide over 5 s the controller asks "
                        + "getSessionHealth and restarts only the decks the "
                        + "plugin reports sick (no session and no automatic "
                        + "reopen pending, reader or writer thread ended, two "
                        + "failed writes or EP0 transfers in a row, heartbeat "
                        + "failures not counted, the latter "
                        + "only on a deck whose control pipe answered at "
                        + "open) through "
                        + "restartSessions({deviceNames}); a healthy deck is "
                        + "restored, never closed. The hide's length goes as "
                        + "quietForMs: an interrupt-IN pipe gone quiet over a "
                        + "sleep looks like an idle deck, so a deck that sent "
                        + "no report over the whole hide is sick (quiet), "
                        + "while one that did, as the press that woke the "
                        + "phone, keeps its session. Once its "
                        + "keyChanged handler is subscribed it calls "
                        + "keyListenerReady, so a press the plugin held since "
                        + "launch reaches that handler; the decks found at "
                        + "boot are painted only after that call, so their "
                        + "USB writes do not age the held presses.",
                    fr: "S'abonne à keyChanged sur chaque deck, throttlé à 150 "
                        + "ms pour éviter le crash IME du WebView. La touche 0 "
                        + "navigue toujours vers /note/<id>; les touches 1-3 ne "
                        + "sont peintes que si une NoteComponent est montée "
                        + "(notifiée via l'event bus STREAMDECK_NOTE_PAGE_ACTIVE) "
                        + "et émettent STREAMDECK_ADD_VIDEO/AUDIO/LOCATION que "
                        + "la note ré-utilise pour ajouter une entrée. Sur "
                        + "visibilitychange:hidden chaque deck dimme à 0 %; "
                        + "un masquage bref restaure la luminosité et repeint. "
                        + "Après plus de 5 s masqué, le contrôleur interroge "
                        + "getSessionHealth et ne redémarre que les decks que "
                        + "le plugin déclare malades (pas de session et aucune "
                        + "réouverture automatique en attente, fil lecteur ou "
                        + "écrivain terminé, deux écritures ou transferts EP0 "
                        + "ratés de suite, sans compter les battements ratés, "
                        + "ces derniers seulement sur un deck "
                        + "dont le canal de contrôle a répondu à l'ouverture) "
                        + "via restartSessions({deviceNames}) ; "
                        + "un deck sain est restauré, jamais fermé. La durée du "
                        + "masquage passe en quietForMs : un canal interrupt-IN "
                        + "devenu muet pendant une veille ressemble à un deck "
                        + "inactif, donc un deck qui n'a envoyé aucun rapport "
                        + "de tout le masquage est malade (quiet), tandis qu'un "
                        + "deck qui en a envoyé, comme la touche qui a réveillé "
                        + "le téléphone, garde sa session. Une fois son "
                        + "gestionnaire keyChanged "
                        + "abonné, il appelle keyListenerReady : une touche que "
                        + "le plugin a retenue depuis le lancement atteint ce "
                        + "gestionnaire ; les decks trouvés au démarrage ne "
                        + "sont peints qu'après cet appel, pour que leurs "
                        + "écritures USB ne vieillissent pas les touches "
                        + "retenues.",
                },
                status: "stable",
                dependsOn: [
                    "streamdeck.bridge-ts",
                    "streamdeck.lifecycle-service",
                ],
                demo: NONE_BG,
                files: [
                    "src/services/streamDeckController.ts",
                    "src/services/streamDeckHealth.ts",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/SessionHealth.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/ControlPipe.java",
                ],
                tests: [
                    "src/__tests__/streamDeckController.test.ts",
                    "src/__tests__/streamDeckHealth.test.ts",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/SessionHealthTest.java",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/ControlPipeTest.java",
                ],
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
                        + "PendingIntent flow; Android drops the grant on unplug. A request "
                        + "completes as soon as UsbManager reports the permission held, "
                        + "whatever granted it (PermissionWaits: a 500 ms poll, the attach "
                        + "intent, each resume), and the USB_DEVICE_ATTACHED intent sent "
                        + "to the running activity opens the deck it names. A hotplug "
                        + "attach shows no dialog of its own: it waits up to 30 s for the "
                        + "confirmation Android raises through the manifest filter "
                        + "(UsbDeviceFilterTest keeps it equal to DeckRegistry), then "
                        + "fails permission_missing; a confirmation cancelled fails it "
                        + "once the app holds the screen again, alone, for 1 s (FocusSpan, "
                        + "PermissionWaits.confirmGone), with no second dialog. Each "
                        + "resume opens every permitted deck nothing holds, except one given up after its reopens failed "
                        + "or whose last attach failed to open it; "
                        + "the journal writes permission_missing, "
                        + "permission_timeout and permission_denied as how to grant it. "
                        + "Detach closes the DeckSession after "
                        + "a 250 ms debounce. requestPermission (the Options "
                        + "\"Demander permission\" button) asks again for one deck or "
                        + "every attached one; PermissionRequestPlan picks the devices and "
                        + "names each outcome: already_granted, granted, denied, timeout "
                        + "after 30 s, error. A session that closes itself while the deck "
                        + "stays plugged in (reader failure, polled_reset, failed writes) "
                        + "is reopened after 2, 4 then 8 s (ReattachPolicy); the count "
                        + "resets after 60 s of healthy session, and after a third failed "
                        + "attempt one line goes to the journal and nothing more is tried; "
                        + "a retry that finds the USB permission missing gives up at once. "
                        + "Unplug, restartSessions, retryAttach and app destroy cancel it; "
                        + "restartSessions and retryAttach give every deck its three "
                        + "attempts back (restartSessions with deviceNames: those decks "
                        + "only), as does any other reopen of a deck given up, "
                        + "the permission button included. A deck whose restart close "
                        + "outlasts the 3 s wait is reopened once that close ends "
                        + "(RestartReopen).",
                    fr: "UsbHotplugReceiver écoute les intents OS ACTION_USB_DEVICE_ATTACHED / "
                        + "DETACHED. UsbPermissionRequester enveloppe le flow PendingIntent par "
                        + "appareil ; Android retire l'autorisation au débranchement. Une "
                        + "demande se termine dès qu'UsbManager rapporte la permission "
                        + "acquise, quel que soit le chemin (PermissionWaits : sondage aux "
                        + "500 ms, intent de branchement, chaque retour au premier plan), et "
                        + "l'intent USB_DEVICE_ATTACHED remis à l'activité en cours ouvre le "
                        + "deck qu'il nomme. Un branchement n'affiche aucun dialogue du "
                        + "plugin : il attend jusqu'à 30 s la confirmation qu'Android lève "
                        + "par le filtre du manifeste (UsbDeviceFilterTest le garde égal à "
                        + "DeckRegistry), puis échoue permission_missing ; une confirmation "
                        + "annulée le fait échouer dès que l'app tient l'écran, seule, depuis 1 s "
                        + "(FocusSpan, PermissionWaits.confirmGone), sans second dialogue. "
                        + "Chaque retour au "
                        + "premier plan ouvre tout deck permis que rien ne tient, sauf "
                        + "celui abandonné après l'échec de ses réouvertures ou dont le "
                        + "dernier branchement a échoué à l'ouvrir ; le journal "
                        + "écrit permission_missing, permission_timeout et permission_denied "
                        + "comme la façon de l'accorder. "
                        + "Détach ferme la DeckSession après "
                        + "un anti-rebond de 250 ms. requestPermission "
                        + "(le bouton « Demander permission ») redemande pour un deck ou pour "
                        + "chaque deck branché ; PermissionRequestPlan choisit les appareils et "
                        + "nomme chaque issue : already_granted, granted, denied, timeout "
                        + "après 30 s, error. Une session qui se ferme d'elle-même, deck "
                        + "toujours branché (échec du lecteur, polled_reset, écritures en "
                        + "échec), est rouverte après 2, 4 puis 8 s (ReattachPolicy) ; le "
                        + "compte revient à zéro après 60 s de session saine, et après un "
                        + "troisième essai raté une ligne part au journal et plus rien "
                        + "n'est tenté ; un essai qui trouve la permission USB absente "
                        + "abandonne aussitôt. Débranchement, restartSessions, retryAttach "
                        + "et destruction de l'app l'annulent ; restartSessions et "
                        + "retryAttach rendent à chaque deck ses trois essais "
                        + "(restartSessions avec deviceNames : à ces decks seulement), "
                        + "comme toute autre réouverture d'un deck abandonné, bouton de "
                        + "permission compris. Un deck dont la fermeture au redémarrage "
                        + "dépasse l'attente de 3 s est rouvert dès qu'elle se termine "
                        + "(RestartReopen).",
                },
                demo: { kind: "options", sectionId: "streamdeck" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/usb/UsbHotplugReceiver.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/usb/UsbPermissionRequester.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/usb/PermissionTimeoutException.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/usb/PermissionWaits.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/FocusSpan.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/PermissionRequestPlan.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/ReattachPolicy.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/ReattachTimers.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/RestartReopen.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/StreamDeckPlugin.java",
                    "src/plugins/streamDeckPlugin.ts",
                    "src/services/streamDeckEventLog.ts",
                ],
                tests: [
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/PermissionRequestPlanTest.java",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/usb/PermissionWaitsTest.java",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/FocusSpanTest.java",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/UsbDeviceFilterTest.java",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/ReattachPolicyTest.java",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/ReattachTimersTest.java",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/RestartReopenTest.java",
                    "src/__tests__/streamDeckPlugin.test.ts",
                    "src/__tests__/streamDeckEventLog.test.ts",
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
                        + "returned EOVERFLOW on Pixel 6 / ThinkPhone XL). "
                        + "UsbRequest mode keeps one request in flight on a "
                        + "direct buffer, queued again only once reaped, and "
                        + "reaps it before closing it (RequestReader).",
                    fr: "Par défaut UsbRequest async sur interrupt-IN. Certains "
                        + "kernels Android cachent cet endpoint, on offre "
                        + "bulkTransfer en repli sync, et polled GET_REPORT "
                        + "sur EP0 en dernier recours. Buffer = "
                        + "epIn.maxPacketSize (fix clé: 64 B retournait "
                        + "EOVERFLOW sur Pixel 6 / ThinkPhone XL). Le mode "
                        + "UsbRequest garde une seule requête en vol sur un "
                        + "buffer direct, remise en file seulement une fois "
                        + "récoltée, et la récolte avant de la fermer "
                        + "(RequestReader).",
                },
                status: "stable",
                dependsOn: [
                    "streamdeck.plugin-native",
                    "streamdeck.usb",
                ],
                demo: { kind: "options", sectionId: "streamdeck" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/DeckSession.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/RequestReader.java",
                ],
            },
            {
                id: "streamdeck.heartbeat",
                label: { en: "USB heartbeat", fr: "Heartbeat USB" },
                description: {
                    en: "700 ms control transfer keeping the bus active, with keep-awake on.",
                    fr: "Control transfer 700 ms pour garder le bus actif, si éveil activé.",
                },
                howItWorks: {
                    en: "Per-session daemon thread issuing GET_REPORT (firmware "
                        + "version) every 700 ms, started and stopped by "
                        + "DeckSession.setHeartbeat from the keepAwake power "
                        + "option (off by default). Without it, Android USB "
                        + "selective suspend stops driving SOFs once the "
                        + "screen goes off and the deck firmware reacts by "
                        + "pulsing LCD brightness at ~1 Hz. Cheap (separate "
                        + "endpoint from reader/writer, no contention).",
                    fr: "Thread daemon par session qui envoie un GET_REPORT "
                        + "(version firmware) toutes les 700 ms, démarré et "
                        + "arrêté par DeckSession.setHeartbeat selon l'option "
                        + "keepAwake (désactivée par défaut). Sans ça, "
                        + "l'autosuspend USB Android arrête les SOFs dès "
                        + "l'écran off et le firmware réagit en pulsant la "
                        + "LCD à ~1 Hz. Coût faible (endpoint séparé, pas "
                        + "de contention).",
                },
                status: "stable",
                dependsOn: ["streamdeck.plugin-native", "streamdeck.power-options"],
                demo: NONE_BG,
                files: ["android/app/src/main/java/ca/erplibre/home/streamdeck/DeckSession.java"],
            },
            {
                id: "streamdeck.power-options",
                label: { en: "Power options", fr: "Options d'énergie" },
                description: {
                    en: "Let the deck wake the screen and show over the lock screen; keep the phone awake. Both off by default.",
                    fr: "Laisser le deck allumer l'écran et afficher sur l'écran verrouillé ; garder le téléphone éveillé. Désactivées par défaut.",
                },
                status: "stable",
                howItWorks: {
                    en: "DeckPowerOptions stores two booleans in SharedPreferences, "
                        + "both false until the user checks them in Options › Stream "
                        + "Deck; the plugin's getPowerOptions / setPowerOptions read "
                        + "and write them. showOverLockScreen: MainActivity calls "
                        + "setShowWhenLocked / setTurnScreenOn only for a launch "
                        + "by the deck — USB_DEVICE_ATTACHED, or the wake-on-key-"
                        + "press relaunch, marked with EXTRA_DECK_WAKE — and "
                        + "clears them in onStop; any other launch stays behind "
                        + "the lock screen. A deck key press lights the screen "
                        + "only with this option (wakeScreenOnKeyPress). keepAwake: the partial wake lock is "
                        + "held and each session sends its 700 ms heartbeat while "
                        + "a deck is open; the lock stays held while a self-closed "
                        + "deck waits to be reopened. Off, the phone may suspend the USB bus "
                        + "with the screen off: the deck may flicker or go dark "
                        + "and its keys may not reach the app, nor wake the phone. "
                        + "deckSleepCoupling ties keepAwake to the Sleep "
                        + "section's deck-lit option, which needs it: turning "
                        + "that option on turns keepAwake on first, and leaves "
                        + "the option off when keepAwake stays off; turning "
                        + "keepAwake off turns that option off, and the section "
                        + "that moved the other one shows a line saying so.",
                    fr: "DeckPowerOptions range deux booléens dans les "
                        + "SharedPreferences, faux tant que l'utilisateur ne les "
                        + "coche pas dans Options › Stream Deck ; getPowerOptions / "
                        + "setPowerOptions du plugin les lisent et les écrivent. "
                        + "showOverLockScreen : MainActivity n'appelle "
                        + "setShowWhenLocked / setTurnScreenOn que pour un lancement "
                        + "par le deck — USB_DEVICE_ATTACHED, ou la relance du "
                        + "réveil sur touche, marquée par EXTRA_DECK_WAKE — et les "
                        + "retire dans onStop ; tout autre lancement reste derrière "
                        + "l'écran verrouillé. Une touche du deck n'allume l'écran "
                        + "qu'avec cette option (wakeScreenOnKeyPress). keepAwake : le verrou de veille "
                        + "partiel est tenu et chaque session envoie son battement "
                        + "de 700 ms tant qu'un deck est ouvert ; le verrou reste "
                        + "tenu tant qu'un deck fermé de lui-même attend sa "
                        + "réouverture. Désactivé, le "
                        + "téléphone peut suspendre le bus USB écran éteint : le "
                        + "deck peut clignoter ou s'éteindre et ses touches ne plus "
                        + "atteindre l'application, ni réveiller le téléphone. "
                        + "deckSleepCoupling lie keepAwake à l'option « deck "
                        + "allumé en veille » de la section Mise en veille, qui "
                        + "en a besoin : cocher celle-ci coche d'abord keepAwake, "
                        + "et la laisse décochée si keepAwake reste désactivé ; "
                        + "décocher keepAwake la décoche, et la section qui a "
                        + "changé l'autre affiche une ligne qui le dit.",
                },
                dependsOn: ["streamdeck.plugin-native"],
                demo: { kind: "options", sectionId: "streamdeck" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/DeckPowerOptions.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/StreamDeckPlugin.java",
                    "android/app/src/main/java/ca/erplibre/home/MainActivity.java",
                    "src/services/streamDeckPowerOptions.ts",
                    "src/services/deckSleepCoupling.ts",
                    "src/components/options/streamdeck/options_streamdeck_component.ts",
                ],
                tests: [
                    "src/__tests__/streamDeckPowerOptions.test.ts",
                    "src/__tests__/deckSleepCoupling.test.ts",
                    "src/__tests__/deckSleepPanels.test.ts",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/DeckPowerOptionsTest.java",
                ],
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
                        + "streamer on stop to avoid the firmware-busy lag. "
                        + "Three failed USB transfers in a row close the "
                        + "session (deckDisconnected, reason usb_lost:…); a "
                        + "single one is a firmware stall and leaves it "
                        + "open. A fire-and-forget batch write that fails "
                        + "is reported as writeFailed in the journal.",
                    fr: "Chaque (deck, key) est un slot ; offrir un nouveau job "
                        + "pour un slot existant remplace l'ancien (résolu "
                        + "comme `dropped`). Thread consommateur unique drain "
                        + "via bulk-OUT. clearPendingWrites() vide la queue "
                        + "sans la fermer — utilisé par le streamer sur stop. "
                        + "Trois transferts USB en échec de suite ferment "
                        + "la session (deckDisconnected, raison usb_lost:…) ; "
                        + "un seul est un blocage du firmware et la laisse "
                        + "ouverte. Une écriture de lot sans retour qui "
                        + "échoue est signalée par writeFailed au journal.",
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
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/WriterStep.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/WriteFailureReporter.java",
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
                        + "during a full-deck refresh. KeyImages rejects a key index outside "
                        + "the deck and an image whose header is larger than the key "
                        + "(image_oversized); clearKey sends each encoder's black image at "
                        + "the key's native size.",
                    fr: "Encoder image par modèle choisi par DeckSpec : decks V1 acceptent du "
                        + "BMP brut, decks V2 du JPEG (meilleure compression, transfert USB plus "
                        + "rapide). Les encoders tournent sur un thread worker pour ne pas "
                        + "bloquer le main thread lors d'un refresh complet. KeyImages refuse "
                        + "un index de touche hors du deck et une image dont l'en-tête dépasse "
                        + "la touche (image_oversized) ; clearKey envoie l'image noire de "
                        + "chaque encoder à la taille native de la touche.",
                },
                demo: NONE_PLUMBING,
                files: [
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/encoder",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/KeyImages.java",
                ],
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
                    en: "V1 transport (Original Stream Deck) writes 8191-byte pages with a "
                        + "prepended report id and page index; V2 transport (Mk.2, XL, Plus, "
                        + "Neo, Pedal) writes 1024-byte pages with the new framing. Choice is "
                        + "driven by DeckSpec.transport — encoders never see the wire "
                        + "format directly. keyStreamReset is one page holding only the "
                        + "report id 0x02: DeckSession.open writes it first, so the deck "
                        + "drops an image the previous session left unfinished.",
                    fr: "Transport V1 (Stream Deck Original) écrit des pages de 8191 octets avec "
                        + "report id + index de page en préfixe; transport V2 (Mk.2, XL, Plus, "
                        + "Neo, Pedal) écrit des pages 1024 bytes avec le nouveau framing. Le "
                        + "choix est piloté par DeckSpec.transport — les encoders ne "
                        + "voient pas le format wire directement. keyStreamReset est une "
                        + "page qui ne porte que le report id 0x02 : DeckSession.open l'écrit "
                        + "d'abord, et le deck abandonne une image que la session précédente "
                        + "a laissée inachevée.",
                },
                demo: NONE_PLUMBING,
                files: ["android/app/src/main/java/ca/erplibre/home/streamdeck/transport"],
                tests: [
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/transport/TransportV1Test.java",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/transport/TransportV2Test.java",
                ],
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
                tests: [
                    "src/__tests__/sleepCameraPanelsI18n.test.ts",
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
                tests: ["src/__tests__/faceDetectionPlugin.test.ts"],
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
                tests: ["src/__tests__/streamDeckLcdTextRenderer.test.ts"],
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
                        + "post-sleep silent-reader state. A deck whose info carries "
                        + "controlPipeOk false shows a line saying brightness and key "
                        + "clearing are off until it answers again, and that a "
                        + "replug restores them.",
                    fr: "Panel Owl listant chaque deck connecté avec : slider brightness "
                        + "(persisté localStorage), dropdown reader-mode (request/bulk/polled), "
                        + "sliders gap de bezels pour le cover-fit camera-stream, et un bouton "
                        + "restart manuel qui déclenche restartSessions pour récupérer du state "
                        + "reader-silencieux post-sleep. Un deck dont les infos portent "
                        + "controlPipeOk faux affiche une ligne disant que luminosité et "
                        + "effacement des touches sont coupés jusqu'à ce qu'il réponde "
                        + "de nouveau, et qu'un rebranchement les rétablit.",
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
                tests: ["src/__tests__/streamDeckPanelI18n.test.ts"],
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
        id: "gallery",
        label: { en: "🖼️ Gallery", fr: "🖼️ Galerie" },
        description: {
            en: "Cross-note image browser — mosaic + fullscreen carousel.",
            fr: "Visionneuse cross-notes — mosaïque + carrousel plein écran.",
        },
        demo: { kind: "route", url: "/applications/gallery" },
        children: [
            {
                id: "gallery.service",
                label: { en: "Gallery service", fr: "Service Galerie" },
                description: {
                    en: "Aggregate every photo entry across the notes.",
                    fr: "Agrège chaque entrée photo de toutes les notes.",
                },
                status: "experimental",
                howItWorks: {
                    en: "Reads every note via DatabaseService.getAllNotes, "
                        + "filters entries of type 'photo' with a non-empty "
                        + "params.path, sorts by note date desc. No mutation "
                        + "API — editing an image still goes through the "
                        + "regular note editor. Read each call (no caching) "
                        + "so the gallery always reflects the latest state.",
                    fr: "Lit chaque note via DatabaseService.getAllNotes, "
                        + "filtre les entrées de type 'photo' avec un "
                        + "params.path non-vide, trie par date de note "
                        + "desc. Pas d'API de mutation — l'édition d'une "
                        + "image passe toujours par l'éditeur de note "
                        + "habituel. Lecture à chaque appel (pas de "
                        + "cache) pour toujours refléter l'état courant.",
                },
                demo: NONE_PLUMBING,
                files: ["src/services/galleryService.ts"],
            },
            {
                id: "gallery.page",
                label: { en: "Gallery page", fr: "Page galerie" },
                description: {
                    en: "Mosaic + swipe-able fullscreen viewer.",
                    fr: "Mosaïque + visionneuse plein-écran swipe-able.",
                },
                status: "experimental",
                howItWorks: {
                    en: "Default mosaic grid (3-6 columns by viewport "
                        + "width) of square thumbnails. Tap a tile → "
                        + "fullscreen carousel; swipe horizontally or use "
                        + "the on-screen prev/next/close buttons to "
                        + "navigate. The fullscreen image is fit-to-"
                        + "screen by default (object-fit: contain) and "
                        + "supports two-finger pinch-zoom up to 4×, "
                        + "one-finger pan once zoomed, double-tap to "
                        + "toggle 1×↔2×, and a single tap on the image "
                        + "to hide/show the close/prev/next chrome. "
                        + "Auto-rotate (default on, ⤢ button) measures "
                        + "the image's natural aspect against the "
                        + "viewer's bounds on load and rotates the "
                        + "image 90° when the orientations don't match, "
                        + "swapping the box dimensions in JS so the "
                        + "rotated bounding box matches the viewer "
                        + "area without overflowing. CSS sets "
                        + "touch-action: none on the viewer so the "
                        + "component owns every gesture; navigation "
                        + "between images resets the zoom. The image "
                        + "path goes through Capacitor.convertFileSrc "
                        + "so the WebView can load it past the origin "
                        + "check.",
                    fr: "Grille mosaïque par défaut (3-6 colonnes selon "
                        + "viewport) de miniatures carrées. Tap sur une "
                        + "tuile → carrousel plein écran; swipe "
                        + "horizontal ou boutons prev/next/close pour "
                        + "naviguer. L'image plein écran est ajustée à "
                        + "l'écran par défaut (object-fit: contain) et "
                        + "supporte le pinch-zoom à deux doigts jusqu'à "
                        + "4×, le pan à un doigt une fois zoomée, le "
                        + "double-tap pour basculer 1×↔2×, et un tap "
                        + "simple sur l'image pour cacher/afficher les "
                        + "boutons close/prev/next. Auto-rotation "
                        + "(activée par défaut, bouton ⤢) compare "
                        + "l'aspect naturel de l'image aux dimensions "
                        + "de la visionneuse au chargement et tourne "
                        + "l'image de 90° quand les orientations ne "
                        + "correspondent pas, avec swap des dimensions "
                        + "du box en JS pour que le bounding box "
                        + "tourné colle à la zone disponible sans "
                        + "déborder. CSS pose touch-action: none sur "
                        + "la visionneuse pour que le composant capte "
                        + "tous les gestes; naviguer entre images "
                        + "réinitialise le zoom. Le path image passe "
                        + "par Capacitor.convertFileSrc pour que le "
                        + "WebView puisse le charger.",
                },
                dependsOn: ["gallery.service"],
                demo: { kind: "route", url: "/applications/gallery" },
                files: [
                    "src/components/applications/gallery/applications_gallery_component.ts",
                    "src/components/applications/gallery/applications_gallery_component.scss",
                ],
            },
            {
                id: "gallery.streamdeck-remote",
                label: {
                    en: "Stream Deck remote",
                    fr: "Télécommande Stream Deck",
                },
                description: {
                    en: "Browse the gallery from the deck — every key is a thumbnail.",
                    fr: "Parcourir la galerie depuis le deck — chaque touche est une miniature.",
                },
                status: "experimental",
                howItWorks: {
                    en: "When the gallery page is mounted, the Owl "
                        + "component fires STREAMDECK_GALLERY_PAGE_ACTIVE "
                        + "with the current image list (URLs + indices). "
                        + "The controller flips into remote mode: keys "
                        + "0..N-4 paint a thumbnail per slot (JPEG, PNG on "
                        + "the BMP decks; loaded "
                        + "via <img> + canvas cover-crop), and the last "
                        + "three keys become prev / next / back. Pressing "
                        + "a thumb fires STREAMDECK_GALLERY_OPEN with the "
                        + "absolute index — the mobile opens the viewer. "
                        + "Pressing back closes fullscreen first, then "
                        + "navigates to /applications on a second press. When "
                        + "the page unmounts, the deck repaints its "
                        + "default Note + Galerie surface. Outside the "
                        + "gallery page, the key directly below the Note "
                        + "key (5 on a 5x3 deck, 8 on the XL; the last key "
                        + "on the Mini) is a permanent shortcut to "
                        + "/applications/gallery.",
                    fr: "Quand la page galerie est montée, le composant "
                        + "Owl émet STREAMDECK_GALLERY_PAGE_ACTIVE avec "
                        + "la liste d'images (URLs + index). Le "
                        + "contrôleur bascule en mode télécommande : "
                        + "touches 0..N-4 affichent une miniature (JPEG, "
                        + "PNG sur les decks BMP) par tuile (chargée via "
                        + "<img> + canvas crop "
                        + "cover), les 3 dernières touches deviennent "
                        + "préc / suiv / retour. Une miniature pressée "
                        + "émet STREAMDECK_GALLERY_OPEN avec l'index "
                        + "absolu — le mobile ouvre la visionneuse. "
                        + "Retour ferme le plein écran d'abord, puis "
                        + "navigue à /applications à la 2e pression. Au "
                        + "démontage, le deck repeint sa surface "
                        + "Note + Galerie par défaut. Hors page "
                        + "galerie, la touche juste sous Note (5 sur un "
                        + "deck 5x3, 8 sur le XL ; la dernière sur le "
                        + "Mini) reste un raccourci permanent vers "
                        + "/applications/gallery.",
                },
                dependsOn: ["gallery.page", "streamdeck.controller"],
                demo: { kind: "route", url: "/applications/gallery" },
                files: [
                    "src/services/streamDeckController.ts",
                    "src/components/applications/gallery/applications_gallery_component.ts",
                ],
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
                    en: "A note is bound to one project.task per sync target "
                        + "(url|username|database) through note_links: push writes that "
                        + "server's own task or creates and links one (one push "
                        + "at a time per note and server). sync_per_server_status "
                        + "holds synced / error / pending per server; the note's "
                        + "sync_status is derived from the live applications' "
                        + "entries (error, then pending, then synced). "
                        + "syncAll(config) pushes the notes pending or in error "
                        + "for that server, so a note queued offline, or whose "
                        + "push failed, leaves on the next sync; a failed "
                        + "creation first waits out its retry delay (30 s "
                        + "doubling to one hour), which a reconnect ignores. "
                        + "Pull pages "
                        + "through the tasks written since a per-server cursor, "
                        + "archived ones included, and copies title, pinned, "
                        + "archived and (Odoo 17+) done onto linked notes, except "
                        + "notes still pending or in error for that server; a note "
                        + "it changes is queued for its other servers. A note "
                        + "edited during its push stays pending. A task deleted "
                        + "on the server marks its link deleted and is recreated "
                        + "only when the user confirms. Creating a note's task "
                        + "runs as its task.create outbox operation: the task "
                        + "carries the operation's erplibre-mobile:<uuid> marker, "
                        + "and a retry searches it first so a create whose answer "
                        + "was lost is adopted instead of duplicated; several "
                        + "matches (a copy made on the server keeps the marker) "
                        + "block it until the user picks the task to link. A "
                        + "retry waits three minutes after the last create sent, "
                        + "so a create the server is still running has committed "
                        + "before the search looks for it.",
                    fr: "Une note est liée à une project.task par cible de sync "
                        + "(url|username|base) via note_links : le push écrit la tâche de CE "
                        + "serveur ou en crée une et la lie (un seul push à la "
                        + "fois par note et serveur). sync_per_server_status porte "
                        + "synced / error / pending par serveur ; le sync_status "
                        + "de la note en est déduit sur les applications encore "
                        + "présentes (error, puis pending, puis synced). "
                        + "syncAll(config) pousse les notes en attente ou en "
                        + "erreur pour ce serveur : une note mise en attente hors "
                        + "ligne, ou dont le push a échoué, part à la sync "
                        + "suivante ; une création en échec attend d'abord son "
                        + "délai (30 s doublées jusqu'à une heure), qu'un retour "
                        + "du réseau ignore. Le pull parcourt par pages les tâches écrites "
                        + "depuis un curseur par serveur, archivées comprises, et "
                        + "recopie titre, épinglage, archivage et (Odoo 17+) fait "
                        + "sur les notes liées, sauf celles encore en attente ou "
                        + "en erreur pour ce serveur ; une note qu'il modifie est "
                        + "mise en attente pour ses autres serveurs. Une note "
                        + "modifiée pendant son push reste en attente. Une tâche "
                        + "supprimée sur le serveur marque son lien supprimé et "
                        + "n'est recréée que si l'utilisateur confirme. La "
                        + "création de la tâche d'une note passe par son opération "
                        + "task.create de la file : la tâche porte le marqueur "
                        + "erplibre-mobile:<uuid> de l'opération, et une reprise le "
                        + "cherche d'abord, si bien qu'un create dont la réponse "
                        + "s'est perdue est repris au lieu d'être dupliqué ; "
                        + "plusieurs résultats (une copie faite sur le serveur "
                        + "garde le marqueur) le bloquent jusqu'à ce que "
                        + "l'utilisateur choisisse la tâche à lier. Une reprise "
                        + "attend trois minutes après le dernier create envoyé, "
                        + "pour qu'un create encore en cours sur le serveur soit "
                        + "validé avant que la recherche ne le cherche.",
                },
                dependsOn: ["deployment.applications"],
                demo: NONE_BG,
                files: [
                    "src/services/syncService.ts",
                    "src/models/syncConfig.ts",
                ],
            },
            {
                id: "sync.odoo-rpc",
                label: { en: "Odoo RPC client and probes", fr: "Client RPC Odoo et sondes" },
                description: {
                    en: "JSON-RPC session, typed calls, cached per-server model probes.",
                    fr: "Session JSON-RPC, appels typés, sondes de modèles en cache par serveur.",
                },
                status: "experimental",
                permissions: ["internet"],
                tests: ["src/__tests__/odooRpcClient.test.ts", "src/__tests__/capabilityService.test.ts"],
                howItWorks: {
                    en: "OdooRpcClient talks to Odoo 16 to 18 through the standard routes "
                        + "only (session/authenticate, dataset/call_kw), keeps one session per "
                        + "url, user and database and re-authenticates once on code 100 or HTTP "
                        + "401. Helpers: searchRead, nameSearch, fieldsGet, defaultGet, "
                        + "checkAccess (has_access on 18, check_access_rights otherwise; null "
                        + "when neither answers) and messagePost. CapabilityService probes a "
                        + "model with fields_get (an unknown model answers KeyError), the three rights "
                        + "and activity_ids / message_ids, never ir.model, and caches the "
                        + "answer in server_capabilities for offline checks; ensure() probes "
                        + "again after a day when online.",
                    fr: "OdooRpcClient parle à Odoo 16 à 18 par les seules routes standard "
                        + "(session/authenticate, dataset/call_kw), garde une session par url, "
                        + "utilisateur et base, et se reconnecte une fois sur le code 100 ou un "
                        + "HTTP 401. Aides : searchRead, nameSearch, fieldsGet, defaultGet, "
                        + "checkAccess (has_access en 18, check_access_rights sinon ; null si "
                        + "aucun ne répond) et messagePost. CapabilityService sonde un modèle "
                        + "par fields_get (un modèle inconnu répond KeyError), les trois droits et "
                        + "activity_ids / message_ids, jamais ir.model, et garde la réponse "
                        + "dans server_capabilities pour valider hors ligne ; ensure() sonde "
                        + "de nouveau après un jour quand le réseau est là.",
                },
                dependsOn: ["deployment.applications"],
                demo: NONE_BG,
                files: [
                    "src/services/odoo/odooRpcClient.ts",
                    "src/services/odoo/capabilityService.ts",
                ],
            },
            {
                id: "sync.task-project",
                label: { en: "Task project", fr: "Projet de la tâche" },
                description: {
                    en: "Project of a note's new task, chosen per server, kept offline.",
                    fr: "Projet de la nouvelle tâche d'une note, choisi par serveur, gardé hors ligne.",
                },
                status: "experimental",
                permissions: ["internet"],
                tests: [
                    "src/__tests__/projectService.test.ts",
                    "src/__tests__/targetPicker.test.ts",
                    "src/__tests__/syncService.test.ts",
                ],
                howItWorks: {
                    en: "A tap on sync with a server where the note has neither task nor "
                        + "opportunity, or where a creation waits for a choice, opens the "
                        + "picker: per server, the project of the new task, or none (a "
                        + "personal task), the server's last choice first. ProjectService "
                        + "lists the active projects online and caches them in "
                        + "remote_records_cache; when the projects cannot be read (offline, "
                        + "server failing) the picker offers the cache, plus \"choose later\", "
                        + "which leaves the creation incomplete until a project is chosen. A "
                        + "cached probe denying task creation greys the Task box; the server "
                        + "is greyed only when nothing can be sent there. The "
                        + "project is set only by create: a task moved on the server stays in "
                        + "its project, and pull and poll read the linked tasks whatever their "
                        + "project. A project gone, archived or hidden, or a create the server "
                        + "refuses, blocks the creation until the next tap chooses again; a "
                        + "task deleted on the server is recreated in the project the picker "
                        + "then asks for.",
                    fr: "Un appui sur sync vers un serveur où la note n'a ni tâche ni "
                        + "opportunité, ou où une création attend un choix, ouvre le "
                        + "sélecteur : par serveur, le projet de la nouvelle tâche, ou aucun "
                        + "(tâche personnelle), le dernier choix du serveur d'abord. "
                        + "ProjectService liste les projets actifs en ligne et les garde dans "
                        + "remote_records_cache ; quand les projets sont illisibles (hors "
                        + "ligne, serveur en échec), le sélecteur propose le cache, plus "
                        + "« choisir plus tard », qui laisse la création incomplète jusqu'au "
                        + "choix d'un projet. Une sonde en cache qui refuse la création de "
                        + "tâches grise la case Tâche ; le serveur n'est grisé que si rien ne "
                        + "peut y partir. Seul le create pose le projet : une "
                        + "tâche déplacée sur le serveur reste dans son projet, et pull et poll "
                        + "lisent les tâches liées quel que soit leur projet. Un projet "
                        + "disparu, archivé ou caché, ou un create refusé, bloque la création "
                        + "jusqu'au prochain appui, qui fait choisir de nouveau ; une tâche "
                        + "supprimée sur le serveur est recréée dans le projet que le "
                        + "sélecteur demande alors.",
                },
                dependsOn: ["sync.service", "sync.outbox", "sync.odoo-rpc"],
                demo: NONE_BG,
                files: [
                    "src/services/odoo/projectService.ts",
                    "src/services/targetPicker.ts",
                    "src/components/note/note_component.ts",
                ],
            },
            {
                id: "sync.lead",
                label: { en: "Opportunity target", fr: "Cible opportunité" },
                description: {
                    en: "Send a note as a CRM opportunity, beside or instead of a task.",
                    fr: "Envoyer une note comme opportunité CRM, à côté ou à la place d'une tâche.",
                },
                status: "experimental",
                permissions: ["internet"],
                tests: [
                    "src/__tests__/syncService.test.ts",
                    "src/__tests__/targetPicker.test.ts",
                    "src/__tests__/recordSearchService.test.ts",
                ],
                howItWorks: {
                    en: "The picker shows, per server, a Task and an Opportunity box, "
                        + "checkable together; the server's last checked kinds are the "
                        + "default for a note with nothing there. An opportunity is a "
                        + "crm.lead created with type opportunity, the note's title, "
                        + "description (with the marker), crm.tag tags, archive state and "
                        + "first date (day only), plus the client and expected revenue "
                        + "chosen, which only create sends; done and pinned do not map. "
                        + "Clients come from name_search, kept in remote_records_cache "
                        + "(200 per server) for offline search. A client gone or hidden "
                        + "blocks the creation until chosen again; the CRM missing or no "
                        + "create right greys the box. Unchecking a kind that waited (blocked, "
                        + "left for later, deleted on the server) drops it: its creation is "
                        + "cancelled and its deleted link dismissed. Each kind is pushed on "
                        + "its own: one waiting for a choice never holds back the other's "
                        + "writes.",
                    fr: "Le sélecteur montre, par serveur, une case Tâche et une case "
                        + "Opportunité, cochables ensemble ; les derniers types cochés du "
                        + "serveur sont le défaut d'une note qui n'y a rien. Une opportunité "
                        + "est un crm.lead créé avec le type opportunity, le titre, la "
                        + "description (avec le marqueur), les étiquettes crm.tag, "
                        + "l'archivage et la première date (le jour) de la note, plus le "
                        + "client et le revenu attendu choisis, que seul le create envoie ; "
                        + "fait et épinglée ne se traduisent pas. Les clients viennent de "
                        + "name_search, gardés dans remote_records_cache (200 par serveur) "
                        + "pour chercher hors ligne. Un client disparu ou caché bloque la "
                        + "création jusqu'à un nouveau choix ; un CRM absent ou sans droit de "
                        + "création grise la case. Décocher un type qui attendait (bloqué, "
                        + "laissé pour plus tard, supprimé sur le serveur) l'abandonne : sa "
                        + "création est annulée et son lien supprimé écarté. Chaque type part "
                        + "seul : celui qui attend un choix ne retient pas les écritures de "
                        + "l'autre.",
                },
                dependsOn: ["sync.task-project", "sync.odoo-rpc"],
                demo: NONE_BG,
                files: ["src/services/odoo/recordSearchService.ts"],
            },
            {
                id: "sync.activity",
                label: { en: "Activity target", fr: "Cible activité" },
                description: {
                    en: "Schedule activities from a note on any record of a server.",
                    fr: "Planifier des activités depuis une note sur n'importe quel record d'un serveur.",
                },
                status: "experimental",
                permissions: ["internet"],
                tests: [
                    "src/__tests__/syncService.test.ts",
                    "src/__tests__/activityPicker.test.ts",
                    "src/__tests__/activityTypeService.test.ts",
                ],
                howItWorks: {
                    en: "The picker lists, per server, the note's activities and adds new "
                        + "ones: a model from a fixed list probed for activity_ids (or a "
                        + "technical name), a record found by name_search (the note's own task "
                        + "or opportunity first), a type from mail.activity.type, a due date "
                        + "(the note's date, else today plus the type's delay) and a user "
                        + "(the connected one by default). A note can have several per server, "
                        + "each its own activity.create row in the outbox and its own "
                        + "note_links row (kind activity, choices in params_json). The create "
                        + "passes default_res_model in the context, so no ir.model read is "
                        + "needed; the record, type and user are checked first. Later pushes "
                        + "write summary and note; a done note calls action_feedback and the "
                        + "link turns done. An activity gone on the server is kept as history.",
                    fr: "Le sélecteur liste, par serveur, les activités de la note et en "
                        + "ajoute : un modèle d'une liste fixe sondée sur activity_ids (ou un "
                        + "nom technique), un record trouvé par name_search (la tâche ou "
                        + "l'opportunité de la note d'abord), un type de mail.activity.type, "
                        + "une échéance (la date de la note, sinon aujourd'hui plus le délai "
                        + "du type) et un utilisateur (celui connecté par défaut). Une note peut "
                        + "en avoir plusieurs par serveur, chacune avec sa ligne "
                        + "activity.create dans la file et sa ligne note_links (type activity, "
                        + "choix dans params_json). Le create passe default_res_model dans le "
                        + "contexte : aucune lecture d'ir.model. Le record, le type et "
                        + "l'utilisateur sont vérifiés avant. Les envois suivants écrivent "
                        + "summary et note ; une note faite appelle action_feedback et le lien "
                        + "passe à fait. Une activité disparue du serveur reste en historique.",
                },
                dependsOn: ["sync.lead", "sync.outbox"],
                demo: NONE_BG,
                files: ["src/services/activityPicker.ts", "src/services/odoo/activityTypeService.ts"],
            },
            {
                id: "sync.message",
                label: { en: "Message in a thread", fr: "Message dans un fil" },
                description: {
                    en: "Post a note as a logged note in any record's chatter, kept up to date.",
                    fr: "Poster une note comme note interne dans le fil de n'importe quel record, tenue à jour.",
                },
                status: "experimental",
                permissions: ["internet"],
                tests: ["src/__tests__/syncService.test.ts", "src/__tests__/activityPicker.test.ts"],
                howItWorks: {
                    en: "Beside activities, the picker's section posts the note in the chatter "
                        + "of a record (same models, probed for message_ids, or a technical "
                        + "name). Each message is its own message.post row in the outbox and "
                        + "note_links row (kind message): message_post as a logged note "
                        + "(mt_note), the title in bold, the text, the marker. A later change "
                        + "of the text edits the message through /mail/message/update_content, "
                        + "the web client's own edit route (Odoo 16 to 18); the hash of the "
                        + "body last sent spares an edit when nothing changed. A message gone "
                        + "on the server is kept as history.",
                    fr: "À côté des activités, la section du sélecteur poste la note dans le "
                        + "fil d'un record (mêmes modèles, sondés sur message_ids, ou un nom "
                        + "technique). Chaque message a sa ligne message.post dans la file et "
                        + "sa ligne note_links (type message) : message_post en note interne "
                        + "(mt_note), le titre en gras, le texte, le marqueur. Un changement "
                        + "du texte édite ensuite le message par /mail/message/update_content, "
                        + "la route d'édition du client web (Odoo 16 à 18) ; l'empreinte du "
                        + "dernier corps envoyé évite une édition quand rien n'a changé. Un "
                        + "message disparu du serveur reste en historique.",
                },
                dependsOn: ["sync.activity", "sync.outbox"],
                demo: NONE_BG,
                files: ["src/services/activityPicker.ts", "src/services/odoo/odooRpcClient.ts"],
            },
            {
                id: "sync.invoice",
                label: { en: "Draft invoice target", fr: "Cible brouillon de facture" },
                description: {
                    en: "Draft a customer invoice or vendor bill from a note, tied to its task or opportunity.",
                    fr: "Rédiger une facture client ou fournisseur en brouillon depuis une note, liée à sa tâche ou à son opportunité.",
                },
                status: "experimental",
                permissions: ["internet"],
                tests: [
                    "src/__tests__/syncService.test.ts",
                    "src/__tests__/targetPicker.test.ts",
                    "src/__tests__/invoiceForm.test.ts",
                ],
                howItWorks: {
                    en: "A third box of the picker, beside Task and Opportunity: one account.move "
                        + "per note and server, created as a draft with its type (out_invoice or "
                        + "in_invoice), partner, date, reference and lines (label, quantity, "
                        + "price, optional product), the note going to narration with the marker. "
                        + "The form is dynamic: fields_get (with depends) and default_get name the "
                        + "required fields the server neither computes nor defaults, asked by "
                        + "type and kept for offline. The tie to the note's task or opportunity "
                        + "writes a settable many2one of account.move to it when a module adds "
                        + "one, else posts a message in each chatter. Later pushes write narration "
                        + "only.",
                    fr: "Une troisième case du sélecteur, à côté de Tâche et Opportunité : un "
                        + "account.move par note et serveur, créé en brouillon avec son type "
                        + "(out_invoice ou in_invoice), son partenaire, sa date, sa référence et "
                        + "ses lignes (libellé, quantité, prix, produit facultatif), la note allant "
                        + "dans narration avec le marqueur. Le formulaire est dynamique : fields_get "
                        + "(avec depends) et default_get donnent les champs obligatoires que le "
                        + "serveur ne calcule ni ne remplit par défaut, demandés par type et gardés "
                        + "hors ligne. Le lien vers la tâche ou l'opportunité de la note écrit un "
                        + "many2one modifiable d'account.move vers elle quand un module en ajoute "
                        + "un, sinon poste un message dans chaque fil. Les envois suivants "
                        + "n'écrivent que narration.",
                },
                dependsOn: ["sync.lead", "sync.outbox"],
                demo: NONE_BG,
                files: ["src/services/odoo/invoiceForm.ts", "src/services/targetPicker.ts"],
            },
            {
                id: "sync.calendar",
                label: { en: "Activity calendar", fr: "Calendrier des activités" },
                description: {
                    en: "A month of the activities of every server, mine and my team's, with done, reschedule and reminders.",
                    fr: "Un mois des activités de tous les serveurs, les miennes et celles de l'équipe, avec fait, report et rappels.",
                },
                status: "experimental",
                permissions: ["internet", "notifications"],
                tests: [
                    "src/__tests__/activityCalendarService.test.ts",
                    "src/__tests__/calendarView.test.ts",
                    "src/__tests__/calendarReminders.test.ts",
                ],
                howItWorks: {
                    en: "Per server, the open mail.activity of the connected user (uid from "
                        + "get_session_info) and of the users chosen, due up to 90 days ahead, "
                        + "overdue ones included, plus on Odoo 17+ those done (archived) in the "
                        + "last 30 days, kept in activities_cache for offline. Team: users "
                        + "chosen by search, plus the members of the user's crm.team. Mark done "
                        + "(action_feedback, after an active check on 17+) and reschedule "
                        + "(date_deadline) apply to the cache at once and wait in the outbox "
                        + "(calendar.done, calendar.reschedule) when offline. A day's \"New "
                        + "note\" creates a dated note and opens the sync picker on an activity "
                        + "due that day. Each refresh reschedules local reminders of the "
                        + "user's open activities (hour and days before, in the sync options).",
                    fr: "Par serveur, les mail.activity ouvertes de l'utilisateur connecté (uid "
                        + "de get_session_info) et des utilisateurs choisis, dues jusqu'à 90 jours, "
                        + "celles en retard comprises, plus en Odoo 17+ celles faites (archivées) "
                        + "depuis 30 jours, gardées dans activities_cache hors ligne. Équipe : des "
                        + "utilisateurs cherchés, plus les membres des crm.team de l'utilisateur. "
                        + "Marquer faite (action_feedback, après lecture d'active en 17+) et "
                        + "reporter (date_deadline) s'appliquent au cache aussitôt et attendent "
                        + "dans la file (calendar.done, calendar.reschedule) hors ligne. « Nouvelle "
                        + "note » d'un jour crée une note datée et ouvre le sélecteur sur une "
                        + "activité due ce jour. Chaque rafraîchissement replanifie les rappels "
                        + "locaux des activités ouvertes (heure et jours avant, dans les options).",
                },
                dependsOn: ["sync.activity", "sync.outbox"],
                demo: { kind: "route", url: "/activities" },
                files: [
                    "src/components/activities/activity_calendar_component.ts",
                    "src/components/activities/activity_calendar_component.scss",
                    "src/services/activityCalendarService.ts",
                    "src/services/calendarView.ts",
                    "src/services/calendarReminders.ts",
                    "src/utils/openRecordInApp.ts",
                ],
            },
            {
                id: "sync.two-way",
                label: { en: "Two-way sync and conflicts", fr: "Sync dans les deux sens et conflits" },
                description: {
                    en: "Server changes come back into the note, field by field; a field changed on both sides is a conflict the user settles.",
                    fr: "Les changements du serveur reviennent dans la note, champ par champ ; un champ changé des deux côtés est un conflit que l'utilisateur règle.",
                },
                status: "experimental",
                permissions: ["internet"],
                tests: ["src/__tests__/noteMirror.test.ts", "src/__tests__/syncService.test.ts"],
                howItWorks: {
                    en: "Each link keeps a base: the note's and the record's mirrored values "
                        + "(title, text, tags, date, done, archived, pinned, as each kind has "
                        + "them) at their last exchange. A pull of tasks, opportunities, invoices "
                        + "and activities (one cursor per model), and every push before writing, "
                        + "read the record and merge three ways: a field changed on the server "
                        + "only goes into the note (the text replacing its text entries), one "
                        + "changed in the app only is written alone, tags as added and removed "
                        + "(commands 4 and 3) and a task's state only when done changed. A field "
                        + "changed on both sides puts the server in conflict: nothing is written "
                        + "until the note's conflict dialog keeps, per field, the app's or the "
                        + "server's version.",
                    fr: "Chaque lien garde une base : les valeurs miroirs de la note et du "
                        + "record (titre, texte, étiquettes, date, fait, archivée, épinglée, selon "
                        + "le type) au dernier échange. Le pull des tâches, opportunités, factures "
                        + "et activités (un curseur par modèle), et chaque envoi avant d'écrire, "
                        + "lisent le record et fusionnent à trois voies : un champ changé sur le "
                        + "serveur seulement entre dans la note (le texte remplaçant ses entrées "
                        + "texte), un champ changé dans l'app seulement est écrit seul, les "
                        + "étiquettes en ajouts et retraits (commandes 4 et 3) et l'état d'une "
                        + "tâche seulement si fait change. Un champ changé des deux côtés met le "
                        + "serveur en conflit : rien n'est écrit avant que l'écran de conflit de "
                        + "la note garde, champ par champ, la version de l'app ou du serveur.",
                },
                dependsOn: ["sync.task-project", "sync.lead", "sync.invoice", "sync.activity"],
                demo: NONE_BG,
                files: ["src/services/noteMirror.ts"],
            },
            {
                id: "sync.background-notice",
                label: { en: "Pending sync notice", fr: "Avis de synchronisation en attente" },
                description: {
                    en: "App closed, a notification tells the notes still waiting for Odoo and opens the app.",
                    fr: "App fermée, une notification signale les notes en attente pour Odoo et ouvre l'app.",
                },
                status: "experimental",
                permissions: ["notifications"],
                tests: ["src/__tests__/pendingSyncNotice.test.ts", "src/__tests__/notificationService.test.ts"],
                howItWorks: {
                    en: "The sync runs only in the app, its logic and encrypted data being in the "
                        + "web view. Going to the background, the app publishes to the native "
                        + "NoteSyncPlugin how many notes wait (pending or in error, plus the "
                        + "calendar's changes) and how many are in conflict, with the texts in its "
                        + "language. NoteSyncJob, a persisted periodic job (15 minutes, network "
                        + "required, apart from the SMS gateway's), shows them while the app is "
                        + "closed; a tap opens the app, whose resume syncs what is due. Coming back "
                        + "to the foreground clears the notice.",
                    fr: "La synchronisation ne tourne que dans l'app, sa logique et ses données "
                        + "chiffrées étant dans la vue web. En passant en arrière-plan, l'app publie "
                        + "au NoteSyncPlugin natif le nombre de notes en attente (à envoyer ou en "
                        + "erreur, plus les changements du calendrier) et en conflit, avec les "
                        + "textes dans sa langue. NoteSyncJob, un travail périodique persistant "
                        + "(15 minutes, réseau requis, distinct de celui de la passerelle SMS), les "
                        + "affiche app fermée ; un appui ouvre l'app, dont la reprise synchronise ce "
                        + "qui est dû. Le retour au premier plan retire l'avis.",
                },
                dependsOn: ["sync.outbox"],
                demo: NONE_BG,
                files: [
                    "src/services/pendingSyncNotice.ts",
                    "src/plugins/noteSyncPlugin.ts",
                    "android/app/src/main/java/ca/erplibre/home/NoteSyncJob.java",
                    "android/app/src/main/java/ca/erplibre/home/NoteSyncPlugin.java",
                ],
            },
            {
                id: "sync.companies",
                label: { en: "Several companies", fr: "Plusieurs sociétés" },
                description: {
                    en: "For a user of several companies, each send chooses the company of the new records.",
                    fr: "Pour un utilisateur de plusieurs sociétés, chaque envoi choisit la société des nouveaux enregistrements.",
                },
                status: "experimental",
                permissions: ["internet"],
                tests: ["src/__tests__/syncService.test.ts"],
                howItWorks: {
                    en: "The picker reads the user's companies from get_session_info "
                        + "(user_companies), kept per server for offline, and shows a choice only "
                        + "when there are several, the last one chosen first. Every call to that "
                        + "server is then made in all of them (allowed_company_ids), so records of "
                        + "each are seen and written; a creation puts the chosen company first, "
                        + "where the server creates the record.",
                    fr: "Le sélecteur lit les sociétés de l'utilisateur dans get_session_info "
                        + "(user_companies), gardées par serveur hors ligne, et ne propose un "
                        + "choix que s'il y en a plusieurs, la dernière choisie d'abord. Chaque "
                        + "appel à ce serveur se fait alors dans toutes (allowed_company_ids), pour "
                        + "voir et écrire les records de chacune ; une création met la société "
                        + "choisie en tête, celle où le serveur crée le record.",
                },
                dependsOn: ["sync.odoo-rpc"],
                demo: NONE_BG,
                files: ["src/services/odoo/odooRpcClient.ts"],
            },
            {
                id: "sync.http-policy",
                label: { en: "Unencrypted http", fr: "http non chiffré" },
                description: {
                    en: "http:// servers refused unless allowed in the options.",
                    fr: "Serveurs http:// refusés sauf autorisation dans les options.",
                },
                status: "experimental",
                tests: ["src/__tests__/httpPolicy.test.ts"],
                howItWorks: {
                    en: "Every request to Odoo goes through OdooRpcClient.rawPost, which "
                        + "refuses an http:// url with InsecureHttpError, before anything is "
                        + "sent, while \"Allow http (unencrypted)\" is off in Options › Odoo "
                        + "sync. Opening an application, or a note's record, in the web view "
                        + "is refused the same way, since its login script types the "
                        + "password. The option is stored in localStorage; unreadable storage "
                        + "counts as off.",
                    fr: "Toute requête vers Odoo passe par OdooRpcClient.rawPost, qui refuse "
                        + "une url http:// par InsecureHttpError, avant tout envoi, tant que "
                        + "« Autoriser http (non chiffré) » est désactivé dans Options › "
                        + "Synchronisation Odoo. Ouvrir une application, ou l'enregistrement "
                        + "d'une note, dans la vue web est refusé de même, son script de "
                        + "connexion tapant le mot de passe. L'option est gardée dans "
                        + "localStorage ; un stockage illisible vaut désactivé.",
                },
                demo: { kind: "options", sectionId: "sync" },
                files: ["src/services/odoo/httpPolicy.ts"],
            },
            {
                id: "sync.outbox",
                label: { en: "Sync outbox", fr: "File d'opérations de sync" },
                description: {
                    en: "Operations waiting to reach a server, kept offline and retried.",
                    fr: "Opérations en attente d'un serveur, gardées hors ligne et retentées.",
                },
                status: "experimental",
                tests: ["src/__tests__/outboxService.test.ts", "src/__tests__/syncService.test.ts"],
                howItWorks: {
                    en: "sync_outbox holds one row per operation of a note on one server, "
                        + "with a client_uuid kept across retries. attempt() stores the "
                        + "attempt count and the running status before the handler talks to "
                        + "the server, deletes the row on success, schedules a retry after "
                        + "30 s doubled per failure (one hour at most), or parks the row as "
                        + "blocked when the handler raises OutboxBlockedError; "
                        + "OutboxRetryLaterError postpones the row without counting an attempt, "
                        + "even past a forced sync. drain(config) "
                        + "runs the due rows oldest first, after the row each depends on; "
                        + "blocked and incomplete rows wait for the user. Rows left running "
                        + "by a killed app turn failed at startup.",
                    fr: "sync_outbox porte une ligne par opération d'une note sur un "
                        + "serveur, avec un client_uuid gardé d'un essai à l'autre. attempt() "
                        + "enregistre le nombre d'essais et l'état running avant que le "
                        + "handler ne parle au serveur, supprime la ligne en cas de succès, "
                        + "planifie un nouvel essai après 30 s doublées à chaque échec (une "
                        + "heure au plus), ou gare la ligne en blocked quand le handler lève "
                        + "OutboxBlockedError ; OutboxRetryLaterError reporte la ligne sans "
                        + "compter d'essai, même lors d'une sync forcée. drain(config) "
                        + "exécute les lignes dues, des plus "
                        + "anciennes aux plus récentes, après celle dont chacune dépend ; les "
                        + "lignes blocked et incomplete attendent l'utilisateur. Les lignes "
                        + "laissées running par une app tuée passent en failed au démarrage.",
                },
                dependsOn: ["sync.service"],
                demo: NONE_BG,
                files: ["src/services/outboxService.ts"],
            },
            {
                id: "sync.network",
                label: { en: "Network detection", fr: "Détection du réseau" },
                description: {
                    en: "Online state and link type; flushes the queue when it comes back.",
                    fr: "État en ligne et type de lien ; vide la file au retour du réseau.",
                },
                status: "experimental",
                tests: ["src/__tests__/networkService.test.ts", "src/__tests__/notificationService.test.ts"],
                howItWorks: {
                    en: "NetworkService reads @capacitor/network (Android "
                        + "ConnectivityManager), falling back to navigator.onLine and the "
                        + "window online event on an APK built without the plugin. "
                        + "NotificationService syncs every server on an offline → online "
                        + "transition, retry delays ignored, and the servers with due work at "
                        + "startup, on each return to the foreground and when a timer reaches "
                        + "the earliest retry time. The plugin's own connected flag needs a "
                        + "validated internet link, so any Wi-Fi or cellular link counts as "
                        + "connected (Ethernet and tethering report \"unknown\"): a server on "
                        + "a LAN without internet stays reachable.",
                    fr: "NetworkService lit @capacitor/network (ConnectivityManager "
                        + "d'Android), avec repli sur navigator.onLine et l'événement online "
                        + "de la fenêtre pour un APK construit sans le plugin. "
                        + "NotificationService synchronise chaque serveur au passage hors "
                        + "ligne → en ligne, sans attendre les délais, et les serveurs qui ont "
                        + "du travail dû au démarrage, à chaque retour au premier plan et "
                        + "quand une minuterie atteint la prochaine heure de reprise. Le "
                        + "« connected » du plugin exige un lien internet validé : tout lien "
                        + "Wi-Fi ou cellulaire compte donc comme connecté (Ethernet et partage "
                        + "de connexion donnent « unknown »), et un serveur sur un réseau "
                        + "local sans internet reste joignable.",
                },
                dependsOn: ["sync.outbox"],
                demo: NONE_BG,
                files: ["src/services/networkService.ts"],
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
                        + "target), addSelectedSyncConfigIds (multi-select), addNoteLinksTable "
                        + "(one remote record per note and url|username|database target, "
                        + "backfilled from odoo_id; older ids gain the database; legacy global "
                        + "pending turned per-server; pull cursors), addSyncOutboxTable "
                        + "(sync_outbox, server_capabilities, note_links.client_uuid), "
                        + "addSyncTargetTables (remote_records_cache, sync_target_prefs), "
                        + "addNoteLinkParams (note_links.params_json), addActivitiesCacheTable "
                        + "(activities_cache). Each migration is "
                        + "idempotent and re-runs safely on app start.",
                    fr: "Étapes de schéma versionnées qui ont fait grandir la sync : "
                        + "addSyncColumns (odoo_id + sync_status initiaux), addSyncConfigId "
                        + "(binding par serveur), addSyncPerServerStatus (ligne sync_status par "
                        + "cible), addSelectedSyncConfigIds (multi-select), addNoteLinksTable "
                        + "(un record distant par note et cible url|username|base, repris "
                        + "d'odoo_id ; les anciens ids reçoivent la base ; l'ancien pending "
                        + "global devient par serveur ; curseurs de pull), addSyncOutboxTable "
                        + "(sync_outbox, server_capabilities, note_links.client_uuid), "
                        + "addSyncTargetTables (remote_records_cache, sync_target_prefs), "
                        + "addNoteLinkParams (note_links.params_json), addActivitiesCacheTable "
                        + "(activities_cache). Chaque migration est "
                        + "idempotente et se ré-exécute sans risque au boot.",
                },
                dependsOn: ["data.migrations"],
                demo: NONE_PLUMBING,
                files: [
                    "src/services/migrations/addSyncColumns.ts",
                    "src/services/migrations/addSyncConfigId.ts",
                    "src/services/migrations/addSyncPerServerStatus.ts",
                    "src/services/migrations/addSelectedSyncConfigIds.ts",
                    "src/services/migrations/addNoteLinksTable.ts",
                    "src/services/migrations/addSyncOutboxTable.ts",
                    "src/services/migrations/addSyncTargetTables.ts",
                    "src/services/migrations/addNoteLinkParams.ts",
                    "src/services/migrations/addActivitiesCacheTable.ts",
                ],
                tests: [
                    "src/__tests__/migrations.test.ts",
                    "src/__tests__/syncService.test.ts",
                    "src/__tests__/outboxService.test.ts",
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
                    "src/__tests__/migrations.test.ts",
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
                id: "code.test-bundle",
                label: { en: "Test bundle", fr: "Bundle de test" },
                description: {
                    en: "Display fixtures: media, text formats, six code projects.",
                    fr: "Documents d'affichage : médias, formats texte, six projets.",
                },
                status: "stable",
                howItWorks: {
                    en: "The third bundle target, after Mobile and ERPLibre. Unlike those two "
                        + "it is not derived from sources — the fixtures ARE the content, so "
                        + "they live in test-bundle/ and vite copies them verbatim to "
                        + "src/public/test/ with an index.json. Under 400 KB. A format that "
                        + "does not display here will not display in a real repository, and it "
                        + "shows without scrolling 82 000 files. PNG, GIF, BMP, SVG and WAV are "
                        + "generated by test-bundle/generate_media.py with the standard library "
                        + "alone; JPEG, WebP, MP3, OGG and ICO are borrowed from the workspace "
                        + "with their licences recorded. Video is absent: H.264 and VP9 need an "
                        + "encoder the machine has not.",
                    fr: "La troisième cible de bundle, après Mobile et ERPLibre. À la "
                        + "différence des deux autres, elle n'est pas dérivée de sources — les "
                        + "fixtures SONT le contenu, elles vivent donc dans test-bundle/ et "
                        + "vite les copie telles quelles vers src/public/test/ avec un "
                        + "index.json. Moins de 400 Ko. Un format qui ne s'affiche pas ici ne "
                        + "s'affichera pas dans un vrai dépôt, et on le voit sans dérouler "
                        + "82 000 fichiers. PNG, GIF, BMP, SVG et WAV sont générés par "
                        + "test-bundle/generate_media.py avec la seule bibliothèque standard ; "
                        + "JPEG, WebP, MP3, OGG et ICO sont empruntés au workspace, licences "
                        + "consignées. La vidéo manque : H.264 et VP9 exigent un encodeur que "
                        + "la machine n'a pas.",
                },
                dependsOn: ["repos.bundle-code"],
                demo: { kind: "route", url: "/options/code?target=test" },
                files: [
                    "test-bundle/README.md",
                    "test-bundle/generate_media.py",
                    "test-bundle/media/PROVENANCE.md",
                    "vite.config.ts",
                ],
                tests: ["src/__tests__/testBundle.test.ts"],
            },
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
                        + "and selects a file at boot. Markdown goes through markdown.ts, which "
                        + "renders tables, six heading levels and nested lists — the repo's own "
                        + "documentation is made of tables.",
                    fr: "Page Owl arbre-à-gauche + contenu-à-droite. Le pane de droite appelle "
                        + "syntax_highlight.ts qui détecte la lang du fichier par extension et "
                        + "fait tourner Prism par ligne; soft-wrap et tab-width sont des prefs "
                        + "localStorage. Deep-link URL (?target=&path=) ouvre un bundle précis "
                        + "et sélectionne un fichier au boot. Le markdown passe par markdown.ts, "
                        + "qui rend les tableaux, six niveaux de titre et les listes imbriquées — "
                        + "la documentation du dépôt est faite de tableaux.",
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
                    "src/components/options/code/markdown.ts",
                ],
                tests: [
                    "src/__tests__/syntaxHighlight.test.ts",
                    "src/__tests__/markdown.test.ts",
                ],
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
                tests: [
                    "src/__tests__/editableCodeService.test.ts",
                    "src/__tests__/migrations.test.ts",
                ],
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
                tests: ["src/__tests__/repoFsFactory.test.ts"],
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
                        + "and transcribe(audioPath) returns the inferred text. Two backends: "
                        + "the on-device whisper.cpp model by default, or the Groq cloud "
                        + "whisper-large-v3 endpoint when the user enables it (key kept in "
                        + "secure-storage). The service never blocks the UI — long jobs go "
                        + "through the processService queue and emit progress events.",
                    fr: "Surface TS autour de WhisperPlugin : isEnabled / setEnabled protègent "
                        + "la feature, getSelectedModel + isModelDownloaded pilotent l'UI "
                        + "picker, et transcribe(audioPath) retourne le texte inféré. Deux "
                        + "backends : le modèle on-device whisper.cpp par défaut, ou le cloud "
                        + "Groq whisper-large-v3 quand activé (clé en secure-storage). Le "
                        + "service ne bloque jamais l'UI — les jobs longs passent par la queue "
                        + "processService et émettent des events de progression.",
                },
                dependsOn: ["transcription.native"],
                demo: NONE_PLUMBING,
                files: [
                    "src/plugins/whisperPlugin.ts",
                    "src/services/transcriptionService.ts",
                ],
                tests: [
                    "src/__tests__/transcriptionService.test.ts",
                    "src/__tests__/whisperPlugin.test.ts",
                    "src/__tests__/transcriptionGroq.test.ts",
                ],
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
                    "src/__tests__/secureFileUtils.test.ts",
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
                    en: "FLAG_KEEP_SCREEN_ON + deck-lit-during-sleep + wake-on-deck-press.",
                    fr: "FLAG_KEEP_SCREEN_ON + deck-allumé-en-veille + réveil-sur-touche.",
                },
                status: "stable",
                issues: [
                    { en: "Battery drain: scales linearly with screen-on time.",
                      fr: "Batterie : draine proportionnel au temps écran allumé." },
                ],
                howItWorks: {
                    en: "Two toggles, each persisted in "
                        + "localStorage and re-applied on boot. "
                        + "(1) Empêcher la mise en veille — KeepAwakePlugin "
                        + "sets FLAG_KEEP_SCREEN_ON on the activity window, "
                        + "Android leaves the screen on, USB stays at full "
                        + "power. (2) Garder le Stream Deck allumé en veille "
                        + "— signals StreamDeckController to skip the "
                        + "brightness=0 dim on visibilitychange:hidden, AND "
                        + "calls StreamDeckPlugin.setWakeOnKeyPress(true) "
                        + "which arms a native keyPressHook in DeckSession. "
                        + "When a key is pressed while MainActivity is "
                        + "paused, the plugin starts the launch intent with "
                        + "REORDER_TO_FRONT if the screen is lit already or "
                        + "the Stream Deck showOverLockScreen power option is "
                        + "on; only that option makes it acquire "
                        + "SCREEN_BRIGHT_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP "
                        + "and show the app over the lock screen. Without "
                        + "it a screen that is off stays off and the press "
                        + "arrives as keyChanged only "
                        + "(DeckPowerOptions.bringAppForwardOnKeyPress, "
                        + "wakeScreenOnKeyPress). A "
                        + "press reaches the reader with the screen off "
                        + "reliably only with keepAwake (see "
                        + "streamdeck.power-options). Hence toggle (2) is "
                        + "coupled to keepAwake by deckSleepCoupling: turning "
                        + "(2) on turns keepAwake on, turning keepAwake off "
                        + "turns (2) off. App boot (restoreDeckSleepAtBoot) "
                        + "arms the plugin from storage, except (2) stored "
                        + "on with keepAwake off: boot turns (2) off, never "
                        + "keepAwake on, and writes one Stream Deck journal "
                        + "line saying so.",
                    fr: "Deux toggles, persistés en "
                        + "localStorage et réappliqués au boot. "
                        + "(1) Empêcher la mise en veille — KeepAwakePlugin "
                        + "pose FLAG_KEEP_SCREEN_ON sur la window de "
                        + "l'activity, Android garde l'écran on, l'USB "
                        + "reste à pleine puissance. (2) Garder le Stream "
                        + "Deck allumé en veille — indique à "
                        + "StreamDeckController de sauter le dim "
                        + "brightness=0 sur visibilitychange:hidden, ET "
                        + "appelle StreamDeckPlugin.setWakeOnKeyPress(true) "
                        + "qui arme un keyPressHook natif dans "
                        + "DeckSession. Sur pression touche pendant que "
                        + "MainActivity est en pause, le plugin lance "
                        + "l'intent avec REORDER_TO_FRONT si l'écran est déjà "
                        + "allumé ou si l'option showOverLockScreen du Stream "
                        + "Deck est activée ; seule cette option lui fait "
                        + "acquérir SCREEN_BRIGHT_WAKE_LOCK | "
                        + "ACQUIRE_CAUSES_WAKEUP et montrer l'application "
                        + "par-dessus l'écran verrouillé. Sans elle, un écran "
                        + "éteint le reste et la touche n'arrive qu'en "
                        + "keyChanged (DeckPowerOptions.bringAppForwardOnKeyPress, "
                        + "wakeScreenOnKeyPress). "
                        + "Une pression n'atteint le lecteur "
                        + "écran éteint de façon fiable qu'avec keepAwake (voir "
                        + "streamdeck.power-options). Le toggle (2) est donc lié "
                        + "à keepAwake par deckSleepCoupling : cocher (2) coche "
                        + "keepAwake, décocher keepAwake décoche (2). Le "
                        + "démarrage (restoreDeckSleepAtBoot) arme le plugin "
                        + "depuis le stockage, sauf (2) enregistré coché avec "
                        + "keepAwake désactivé : le démarrage décoche (2), "
                        + "sans jamais cocher keepAwake, et l'écrit sur une "
                        + "ligne du journal du Stream Deck.",
                },
                demo: { kind: "options", sectionId: "keep-awake" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/KeepAwakePlugin.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/StreamDeckPlugin.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/DeckSession.java",
                    "android/app/src/main/java/ca/erplibre/home/streamdeck/DeckPowerOptions.java",
                    "android/app/src/main/java/ca/erplibre/home/MainActivity.java",
                    "src/plugins/keepAwakePlugin.ts",
                    "src/services/streamDeckController.ts",
                    "src/services/deckSleepCoupling.ts",
                    "src/components/options/keep_awake/options_keep_awake_component.ts",
                    "src/js/app.ts",
                ],
                tests: [
                    "src/__tests__/keepAwakePlugin.test.ts",
                    "src/__tests__/deckSleepCoupling.test.ts",
                    "src/__tests__/deckSleepPanels.test.ts",
                    "src/__tests__/sleepCameraPanelsI18n.test.ts",
                    "android/app/src/test/java/ca/erplibre/home/streamdeck/DeckPowerOptionsTest.java",
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
                tests: ["src/__tests__/deviceStatsPlugin.test.ts"],
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
                    en: "Read location, camera and SMS states; request the SMS ones.",
                    fr: "Lire localisation, caméra et SMS ; demander celles des SMS.",
                },
                status: "stable",
                howItWorks: {
                    en: "Reads location (fine and coarse) and camera/photos through each "
                        + "plugin's checkPermissions(), and the two SMS permissions through the "
                        + "gateway plugin's getCapabilities(). When an SMS permission is "
                        + "missing it offers to ask for it and calls requestSmsPermissions(): "
                        + "the only one this panel can request, the others belonging to their "
                        + "own plugin. The right to send an SMS was otherwise reachable only "
                        + "from the gateway screen, where no one looking for permissions goes, "
                        + "and a reinstall resets it to denied.",
                    fr: "Lit la localisation (précise et approximative) et caméra/photos par le "
                        + "checkPermissions() de chaque plugin, et les deux permissions SMS par "
                        + "le getCapabilities() du plugin passerelle. Quand une permission SMS "
                        + "manque, propose de la demander et appelle requestSmsPermissions() : "
                        + "la seule que ce panneau puisse demander, les autres appartenant à "
                        + "leur propre plugin. Le droit d'envoyer un SMS n'était sinon "
                        + "accessible que depuis l'écran de la passerelle, où ne va pas qui "
                        + "cherche ses permissions, et une réinstallation le remet à refusée.",
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
                tests: [
                    "src/__tests__/processService.test.ts",
                    "src/__tests__/migrations.test.ts",
                ],
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
                tests: ["src/__tests__/sshPlugin.test.ts"],
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
                tests: ["src/__tests__/rawHttpPlugin.test.ts"],
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
                tests: [
                    "src/__tests__/appService.test.ts",
                    "src/__tests__/migrations.test.ts",
                ],
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
                tests: [
                    "src/__tests__/reminderService.test.ts",
                    "src/__tests__/migrations.test.ts",
                ],
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
                    "src/utils/webViewUtils.ts",
                ],
                tests: ["src/__tests__/webViewUtils.test.ts"],
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
                tests: ["src/__tests__/enhancedComponent.test.ts"],
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
                tests: ["src/__tests__/errors.test.ts"],
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
                        + "devices that can't easily check the website. No copy of the "
                        + "text in the code: the version shown is the first dated heading.",
                    fr: "Lit CHANGELOG.md depuis le bundle au boot, parse les sections H2 par "
                        + "date, et rend les entrées les plus récentes dans un popover. Pas de "
                        + "réseau — ce qui est là est ce qui a été livré dans l'APK. Utile pour "
                        + "les users sur appareils terrain qui ne peuvent pas checker le site "
                        + "facilement. Aucune copie du texte dans le code : la version "
                        + "affichée vient du premier titre daté du fichier.",
                },
                demo: { kind: "options", sectionId: "changelog" },
                files: [
                    "src/components/options/changelog/options_changelog_component.ts",
                    "src/utils/changelogUtils.ts",
                ],
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
                        + "validity, and orphan detection. The vite plugin "
                        + "feature-touched runs git log -1 per file at "
                        + "build time and writes feature_touched.json so the "
                        + "dashboard can surface stale features.",
                    fr: "FEATURE_TREE dans src/data/featureCatalog.ts est la "
                        + "source de vérité. /options/features rend l'arbre "
                        + "via un composant récursif (recherche, deep-link, "
                        + "détail par noeud). Suite vitest vérifie unicité, "
                        + "existence des fichiers, validité dependsOn, et "
                        + "détection d'orphelins. Le plugin vite "
                        + "feature-touched run git log -1 par fichier au "
                        + "build et écrit feature_touched.json pour que le "
                        + "dashboard puisse surfacier les features périmées.",
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
                    "src/__tests__/featureSection.test.ts",
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
                tests: ["src/__tests__/helpers.test.ts"],
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
                        + "writes it to src/public/build_id.json — a build output, not a source "
                        + "file, so it is gitignored. RepoEditService reads it to tag the "
                        + "baseline commit of an editable repo, which is how baseline drift is "
                        + "detected after a rebuild.",
                    fr: "Plugin Vite génère un (gitShortSha + timestamp) à chaque build et "
                        + "l'écrit dans src/public/build_id.json — une sortie de build, pas un "
                        + "fichier source, donc gitignoré. RepoEditService le lit pour étiqueter "
                        + "le commit de référence d'un dépôt éditable, ce qui permet de détecter "
                        + "une dérive de référence après recompilation.",
                },
                demo: NONE_PLUMBING,
                files: ["vite.config.ts", "src/services/repoEditService.ts"],
            },
        ],
    },
    {
        id: "i18n",
        label: { en: "🌐 Language", fr: "🌐 Langue" },
        description: {
            en: "Interface in French or English, switched at runtime from Options.",
            fr: "Interface en français ou en anglais, changée à chaud depuis Options.",
        },
        demo: { kind: "route", url: "/options/language" },
        children: [
            {
                id: "i18n.catalogues",
                label: { en: "fr-CA / en-CA catalogues", fr: "Catalogues fr-CA / en-CA" },
                description: {
                    en: "Flat key/string tables read through t(), with parameter substitution.",
                    fr: "Tables plates clé/chaîne lues par t(), avec substitution de paramètres.",
                },
                howItWorks: {
                    en: "t(key, params) looks the key up in the active catalogue and replaces "
                        + "{name} placeholders. Keys are English sentences turned into dotted "
                        + "identifiers, so a missing translation degrades to the key itself "
                        + "rather than to an empty string.",
                    fr: "t(cle, params) cherche la cle dans le catalogue actif et remplace les "
                        + "marqueurs {nom}. Les cles sont des phrases anglaises transformees en "
                        + "identifiants pointes : une traduction absente degrade vers la cle "
                        + "elle-meme, pas vers une chaine vide.",
                },
                demo: NONE_PLUMBING,
                files: ["src/i18n/index.ts", "src/i18n/fr.ts", "src/i18n/en.ts"],
            },
            {
                id: "i18n.picker",
                label: { en: "Language picker", fr: "Sélecteur de langue" },
                description: {
                    en: "Options entry that switches the interface language without a restart.",
                    fr: "Entrée d'Options qui change la langue de l'interface sans redémarrage.",
                },
                demo: { kind: "route", url: "/options/language" },
                files: [
                    "src/components/options/language/options_language_component.ts",
                    "src/components/options/language/options_language_component.scss",
                ],
            },
        ],
    },
    {
        id: "translation",
        label: { en: "🔤 Translation", fr: "🔤 Traduction" },
        description: {
            en: "French ↔ English translation, on-device or through a backend.",
            fr: "Traduction français ↔ anglais, sur l'appareil ou via un service.",
        },
        demo: { kind: "route", url: "/options/translation" },
        children: [
            {
                id: "translation.backends",
                label: { en: "Pluggable backends", fr: "Services interchangeables" },
                description: {
                    en: "One of several translation backends, chosen in Options and persisted.",
                    fr: "Un service de traduction parmi plusieurs, choisi dans Options et conservé.",
                },
                demo: { kind: "route", url: "/options/translation" },
                files: [
                    "src/services/translationService.ts",
                    "src/components/options/translation/options_translation_component.ts",
                    "src/components/options/translation/options_translation_component.scss",
                ],
            },
            {
                id: "translation.marian",
                label: { en: "MarianMT on device", fr: "MarianMT sur l'appareil" },
                description: {
                    en: "Helsinki-NLP MarianMT ONNX models translating with no network at all.",
                    fr: "Modèles ONNX MarianMT d'Helsinki-NLP traduisant sans aucun réseau.",
                },
                howItWorks: {
                    en: "The Java plugin tokenises with SentencePiece, runs the ONNX encoder, "
                        + "then beam-search decodes. MarianLib.isAvailable() returns false when "
                        + "libmarian_jni.so failed to load, so the app still runs when "
                        + "sentencepiece was never compiled.",
                    fr: "Le plugin Java tokenise avec SentencePiece, execute l'encodeur ONNX, "
                        + "puis decode en recherche par faisceau. MarianLib.isAvailable() rend "
                        + "faux quand libmarian_jni.so n'a pas pu etre charge : l'application "
                        + "tourne quand meme si sentencepiece n'a jamais ete compile.",
                },
                demo: { kind: "route", url: "/options/translation" },
                files: [
                    "src/services/marianService.ts",
                    "src/plugins/marianPlugin.ts",
                ],
            },
        ],
    },
    {
        id: "sms-gateway",
        label: { en: "SMS gateway", fr: "Passerelle SMS" },
        description: {
            en: "Turns the phone into the SMS sender for an ERPLibre server.",
            fr: "Fait du téléphone l'émetteur SMS d'un serveur ERPLibre.",
        },
        permissions: ["sms"],
        status: "experimental",
        howItWorks: {
            en: "The phone polls Odoo over HTTPS rather than being pushed to, "
                + "so it needs no inbound port and no public address. Every "
                + "exchange is HMAC-signed with a shared secret held in the "
                + "server's environment. Work is persisted to SQLite before "
                + "anything is sent: a killed process resumes instead of "
                + "silently dropping an alert. Cycles are driven by "
                + "AlarmManager, not Thread.sleep, whose clock stops while the "
                + "device is suspended.",
            fr: "Le téléphone interroge Odoo en HTTPS au lieu d'être poussé, "
                + "donc il n'a besoin ni de port entrant ni d'adresse publique. "
                + "Chaque échange est signé en HMAC avec un secret partagé, gardé "
                + "dans l'environnement du serveur. Le travail est écrit en SQLite "
                + "avant tout envoi : un processus tué reprend au lieu de perdre "
                + "une alerte en silence. Les cycles sont pilotés par AlarmManager "
                + "et non par Thread.sleep, dont l'horloge s'arrête quand "
                + "l'appareil se suspend.",
        },
        demo: { kind: "route", url: "/options/sms_gateway" },
        files: [
            "src/plugins/smsGatewayPlugin.ts",
            "src/utils/smsGatewayUtils.ts",
        ],
        children: [
            {
                id: "sms-gateway.service",
                label: { en: "Background service", fr: "Service d'arrière-plan" },
                description: {
                    en: "Foreground service that polls, sends, and reports back.",
                    fr: "Service de premier plan qui interroge, envoie et rend compte.",
                },
                status: "experimental",
                demo: { kind: "route", url: "/options/sms_gateway" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/SmsGatewayService.java",
                    "android/app/src/main/java/ca/erplibre/home/SmsOutbox.java",
                    "android/app/src/main/java/ca/erplibre/home/OdooReporter.java",
                    "android/app/src/main/java/ca/erplibre/home/SmsResultReceiver.java",
                    "android/app/src/main/java/ca/erplibre/home/SmsInboundReceiver.java",
                    "android/app/src/main/java/ca/erplibre/home/SmsBootReceiver.java",
                ],
            },
            {
                id: "sms-gateway.journal",
                label: { en: "Local log", fr: "Journal local" },
                description: {
                    en: "Records what only the device knows, with a size-capped purge.",
                    fr: "Consigne ce que seul l'appareil sait, avec purge plafonnée.",
                },
                status: "experimental",
                howItWorks: {
                    en: "Odoo keeps the view of messages sent; this keeps what only "
                        + "the phone knows — permission revoked, SIM missing, server "
                        + "unreachable. Only changes are recorded, never every cycle. "
                        + "Metadata only by default: bodies sit behind a setting, "
                        + "because enabling it writes member data onto a device that "
                        + "can be lost.",
                    fr: "Odoo garde la vue des envois ; ceci garde ce que seul le "
                        + "téléphone sait — permission retirée, SIM absente, serveur "
                        + "injoignable. Seuls les changements sont consignés, jamais "
                        + "chaque cycle. Métadonnées seules par défaut : le corps des "
                        + "messages est derrière un réglage, car l'activer écrit des "
                        + "données de membres sur un appareil qui peut se perdre.",
                },
                demo: { kind: "route", url: "/options/sms_gateway" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/SmsJournal.java",
                ],
            },
            {
                id: "sms-gateway.screen",
                label: { en: "Supervision screen", fr: "Écran de supervision" },
                description: {
                    en: "Health banner, configuration, and the log.",
                    fr: "Bandeau d'état, configuration et journal.",
                },
                permissions: ["phone_state"],
                status: "experimental",
                demo: { kind: "route", url: "/options/sms_gateway" },
                files: [
                    "src/components/options/sms_gateway/options_sms_gateway_component.ts",
                    "src/components/options/sms_gateway/options_sms_gateway_component.scss",
                    "android/app/src/main/java/ca/erplibre/home/SmsGatewayPlugin.java",
                    "android/app/src/main/java/ca/erplibre/home/SmsGatewayConfig.java",
                ],
            },
            {
                id: "sms-gateway.dialer-keypad",
                label: { en: "Keypad", fr: "Clavier de composition" },
                description: {
                    en: "Compose a number from the app when it holds the dialer role.",
                    fr: "Composer un numéro depuis l'app quand elle tient le rôle.",
                },
                permissions: ["calls"],
                status: "experimental",
                howItWorks: {
                    en: "The Home tile appears only while the app actually holds "
                        + "the dialer role, checked against the native side on "
                        + "every mount — the role can be handed back from Android "
                        + "Settings without going through us, so a cached value "
                        + "would eventually lie. Offering a keypad without "
                        + "control over calls would be a button that cannot keep "
                        + "its promise. The call goes out through the SAME path "
                        + "as Odoo's click-to-dial, so it is traced and reported "
                        + "like any other; a second dialling path bypassing the "
                        + "log would produce calls invisible to Odoo, which is "
                        + "exactly what the gateway exists to prevent.",
                    fr: "La tuile d'Accueil n'apparaît que si l'application tient "
                        + "réellement le rôle de composeur, vérifié auprès du "
                        + "natif à chaque affichage — le rôle se rend depuis les "
                        + "Réglages d'Android sans passer par nous, donc une "
                        + "valeur en cache finirait par mentir. Proposer un "
                        + "clavier sans avoir la main sur les appels donnerait un "
                        + "bouton incapable de tenir sa promesse. L'appel part "
                        + "par le MÊME chemin que le clic-pour-appeler d'Odoo : "
                        + "il est donc tracé et remonté comme les autres. Un "
                        + "second chemin de composition échappant au journal "
                        + "produirait des appels invisibles côté Odoo — "
                        + "précisément ce que la passerelle existe pour éviter.",
                },
                demo: { kind: "route", url: "/phone" },
                files: [
                    "src/components/phone/phone_dialer_component.ts",
                    "src/components/phone/phone_dialer_component.scss",
                    "src/components/home/home_component.ts",
                ],
            },
            {
                id: "sms-gateway.dialer-probe",
                label: {
                    en: "Dialer role (probe)",
                    fr: "Rôle de composeur (sonde)",
                },
                description: {
                    en: "Becomes the default phone app to learn when a call is answered.",
                    fr: "Devient le téléphone par défaut pour connaître l'instant du décroché.",
                },
                permissions: ["calls"],
                status: "experimental",
                howItWorks: {
                    en: "No public API tells an ordinary app when the other party "
                        + "answers an outgoing call: Telecom files DIALING and "
                        + "ACTIVE under the same CALL_STATE_OFFHOOK, and the "
                        + "transition emits no event at all. PreciseCallState "
                        + "does distinguish them but is signature|privileged — "
                        + "measured on the device: declarable, never granted, and "
                        + "pm grant refuses it. An InCallService gives "
                        + "Call.STATE_ACTIVE, and it is the only way. The catch: "
                        + "once bound, Telecom stops showing the system call "
                        + "screen and shows ours, so an incomplete screen would "
                        + "leave someone in a call with no hang-up button. Hence "
                        + "a native layout with no webview and no loading. "
                        + "Reversible from Settings > Default apps at any time.",
                    fr: "Aucune interface publique ne dit à une application "
                        + "ordinaire quand le correspondant décroche un appel "
                        + "sortant : Telecom range DIALING et ACTIVE sous le même "
                        + "CALL_STATE_OFFHOOK, et la transition n'émet aucun "
                        + "événement. PreciseCallState les distingue mais est en "
                        + "signature|privileged — mesuré sur l'appareil : "
                        + "déclarable, jamais accordée, et pm grant la refuse. Un "
                        + "InCallService donne Call.STATE_ACTIVE, et c'est la "
                        + "seule voie. La contrepartie : une fois lié, Telecom "
                        + "cesse d'afficher l'écran d'appel du système et affiche "
                        + "le nôtre — un écran incomplet laisserait quelqu'un en "
                        + "communication sans bouton pour raccrocher. D'où une "
                        + "mise en page native, sans webview ni chargement. "
                        + "Réversible depuis Réglages > Applications par défaut.",
                },
                demo: { kind: "route", url: "/options/sms_gateway" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/phone/PhoneCallService.java",
                    "android/app/src/main/java/ca/erplibre/home/phone/InCallActivity.java",
                    "android/app/src/main/java/ca/erplibre/home/phone/DialerActivity.java",
                    "android/app/src/main/java/ca/erplibre/home/phone/CallRole.java",
                    "android/app/src/main/res/layout/activity_in_call.xml",
                ],
            },
            {
                id: "sms-gateway.watchdog",
                label: {
                    en: "Watchdog and restart",
                    fr: "Surveillance et relance",
                },
                description: {
                    en: "Detects a dead service, restarts it, and logs it.",
                    fr: "Detecte un service mort, le relance, et le consigne.",
                },
                status: "experimental",
                howItWorks: {
                    en: "The service's own alarm lives INSIDE the service, so "
                        + "when Android kills it the alarm dies too and nothing "
                        + "notices the silence. A JobScheduler job belongs to "
                        + "the system instead, survives the process, and is "
                        + "persisted across reboots — 15 min is Android's floor "
                        + "for a periodic job, coarse but it only has to catch "
                        + "death, not pace the work. The screen also restarts on "
                        + "sight, capped at two tries so a service that refuses "
                        + "to start is not hammered. Deliberate stops cancel the "
                        + "watchdog; otherwise it would revive what someone just "
                        + "turned off. Every start, stop and revival is written "
                        + "to its own log category, separating 'stopped by the "
                        + "user' from 'killed by Android' — the first reads as a "
                        + "decision, the second as a fault.",
                    fr: "L'alarme du service vit DANS le service : quand Android "
                        + "le tue, elle meurt avec lui et plus rien ne remarque "
                        + "le silence. Un travail JobScheduler appartient au "
                        + "systeme, survit au processus et traverse les "
                        + "redemarrages — 15 min est le plancher d'Android pour "
                        + "un travail periodique, grossier mais il ne doit "
                        + "rattraper qu'une mort, pas cadencer le travail. "
                        + "L'ecran releve aussi des qu'il constate la panne, "
                        + "borne a deux tentatives pour ne pas marteler un "
                        + "service qui refuse de demarrer. Un arret VOULU retire "
                        + "la surveillance, sinon elle rallumerait ce qu'on vient "
                        + "d'eteindre. Chaque demarrage, arret et relance va dans "
                        + "sa propre categorie de journal, en distinguant "
                        + "« arretee par l'utilisatrice » de « tuee par "
                        + "Android » : la premiere se lit comme une decision, la "
                        + "seconde comme une panne.",
                },
                demo: { kind: "route", url: "/options/sms_gateway" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/SmsWatchdogJob.java",
                    "android/app/src/main/java/ca/erplibre/home/SmsBootReceiver.java",
                    "android/app/src/main/java/ca/erplibre/home/SmsGatewayService.java",
                ],
            },
            {
                id: "sms-gateway.calls",
                label: { en: "Traced phone calls", fr: "Appels tracés" },
                description: {
                    en: "Places and logs calls, and measures their duration.",
                    fr: "Place et journalise les appels, et mesure leur durée.",
                },
                permissions: ["calls", "call_log"],
                status: "experimental",
                howItWorks: {
                    en: "Calls are placed with TelecomManager.placeCall, not an "
                        + "ACTION_CALL activity: since API 29 Android silently "
                        + "drops background activity starts, and a foreground "
                        + "service does not lift that ban. State lives in SQLite, "
                        + "never in memory, so a restart does not strand a call in "
                        + "'dialing'. Duration is measured OFFHOOK→IDLE, and read "
                        + "back from the system call log when that permission is "
                        + "granted — the log is authoritative, the measure is the "
                        + "fallback.",
                    fr: "Les appels partent par TelecomManager.placeCall et non "
                        + "par une activité ACTION_CALL : depuis l'API 29 Android "
                        + "supprime silencieusement les lancements d'activité en "
                        + "arrière-plan, et un service au premier plan ne lève pas "
                        + "cette interdiction. L'état vit dans SQLite et jamais en "
                        + "mémoire, pour qu'un redémarrage ne laisse pas un appel "
                        + "bloqué en « composition ». La durée est mesurée "
                        + "OFFHOOK→IDLE, puis relue dans le journal d'appels du "
                        + "système quand la permission est accordée — le journal "
                        + "fait foi, la mesure est le repli.",
                },
                demo: { kind: "route", url: "/options/sms_gateway" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/PhoneCalls.java",
                    "android/app/src/main/java/ca/erplibre/home/SmsOutbox.java",
                ],
            },
            {
                id: "sms-gateway.demo-call-audio",
                permissions: ["audio_routing"],
                label: {
                    en: "Tune during a call (demo)",
                    fr: "Mélodie pendant un appel (démo)",
                },
                description: {
                    en: "Measured dead end: echo cancellation removes it from the uplink.",
                    fr: "Impasse mesurée : l'annulation d'écho la retire du flux émis.",
                },
                status: "experimental",
                howItWorks: {
                    en: "MEASURED 30 Aug 2026: this does not work — the other "
                        + "party hears nothing. Kept as a record of what was "
                        + "tried, off by default. Android exposes no API to "
                        + "inject audio into a cellular "
                        + "call: that stream belongs to the modem. The only way an "
                        + "ordinary app has is to force speakerphone and let the "
                        + "device's own microphone pick the tune back up. The voice "
                        + "pipeline runs echo cancellation, whose whole job is to "
                        + "remove what the device just emitted, so it actively "
                        + "fights this. Audible but muffled — a demo, never an "
                        + "announcement to members. Off by default; the routing "
                        + "attempt is verified and journalled rather than assumed, "
                        + "because on Android 12+ call routing belongs to the "
                        + "dialer app.",
                    fr: "MESURÉ le 30 août 2026 : cela ne fonctionne pas — le "
                        + "correspondant n'entend rien. Conservé comme trace de "
                        + "l'essai, désactivé par défaut. Android n'expose "
                        + "aucune interface pour injecter du son "
                        + "dans un appel cellulaire : ce flux appartient au modem. "
                        + "Le seul moyen d'une application ordinaire est de forcer "
                        + "le haut-parleur et de laisser le micro de l'appareil "
                        + "reprendre la mélodie. Le pipeline voix applique une "
                        + "annulation d'écho, dont le travail est justement de "
                        + "supprimer ce que l'appareil vient d'émettre : elle "
                        + "combat le montage. Audible mais étouffé — une "
                        + "démonstration, jamais une annonce à des membres. "
                        + "Désactivé par défaut ; la tentative de routage est "
                        + "vérifiée et journalisée plutôt que supposée, car sur "
                        + "Android 12+ le routage d'un appel appartient à "
                        + "l'application téléphone.",
                },
                demo: { kind: "route", url: "/options/sms_gateway" },
                files: [
                    "android/app/src/main/java/ca/erplibre/home/CallAudio.java",
                    "android/app/src/main/java/ca/erplibre/home/PhoneCalls.java",
                    "android/app/src/main/res/raw/demo_musique.wav",
                ],
            },
        ],
    },
];
