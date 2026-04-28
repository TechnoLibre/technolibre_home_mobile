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
                        dependsOn: ["transcription.bridge"],
                        status: "stable",
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
                demo: { kind: "options", sectionId: "streamdeck" },
                files: ["src/services/streamDeckEventLog.ts"],
            },
            {
                id: "streamdeck.options-panel",
                label: { en: "Diagnostic panel", fr: "Panel diagnostique" },
                description: {
                    en: "Per-deck brightness, reader mode, bezel sliders, restart.",
                    fr: "Brightness, reader mode, sliders bezels, redémarrage.",
                },
                status: "stable",
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
                demo: NONE_BG,
                files: [
                    "src/services/ntfyService.ts",
                    "src/services/notificationService.ts",
                    "src/services/migrations/addNtfyTokenColumn.ts",
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
                demo: { kind: "options", sectionId: "code-style" },
                files: [
                    "src/services/codeStyleService.ts",
                    "src/components/options/code_style/options_code_style_component.ts",
                ],
            },
            {
                id: "code.editable",
                label: { en: "Editable code repos", fr: "Repos éditables" },
                description: {
                    en: "Persist user edits in a SQLite-backed overlay.",
                    fr: "Persiste les édits user dans un overlay SQLite.",
                },
                status: "stable",
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
            },
            {
                id: "security.dev-mode",
                label: { en: "Dev mode unlock", fr: "Déverrouillage dev mode" },
                description: {
                    en: "Tap-counter on device-info row reveals debug screens.",
                    fr: "Tap-counter sur la ligne info appareil débloque les écrans debug.",
                },
                status: "stable",
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
                dependsOn: ["deployment.ssh"],
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
                demo: NONE_PLUMBING,
                files: [
                    "src/js/app.ts",
                    "src/js/helpers.ts",
                ],
                tests: ["src/__tests__/appService.test.ts"],
            },
            {
                id: "meta.build-id",
                label: { en: "Build ID", fr: "Build ID" },
                description: {
                    en: "Per-build hash + timestamp for crash triage.",
                    fr: "Hash + timestamp par build pour le triage.",
                },
                status: "stable",
                demo: NONE_PLUMBING,
                files: ["src/public/build_id.json"],
            },
        ],
    },
];
