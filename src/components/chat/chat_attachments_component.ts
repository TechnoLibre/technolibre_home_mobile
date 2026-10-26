import { onMounted, onPatched, onWillUnmount, useRef, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { getCurrentLocale, t } from "../../i18n";
import type { ChatAttachment } from "../../models/chat";
import { onItsWay, type ChatAttachmentCache, type OpenResult } from "../../services/chat/chatAttachmentCache";
import type { ChatFiles } from "../../services/chat/chatFiles";
import { CHAT_FILE_NO_APP } from "../../plugins/chatFilePlugin";
import type { ChatSource } from "../../services/chat/chatSources";
import { formatBytes } from "../../utils/formatBytes";
import { attachmentKind, type AttachmentKind } from "../../services/chat/chatBody";

export { attachmentKind, type AttachmentKind };

/** Poll period while a file of the screen is on the wire: progress moves. */
export const PROGRESS_POLL_MS = 250;
/** Poll period while a file waits (an upload not started, a Wi-Fi hold): only its start is looked for. */
export const WAIT_POLL_MS = 1000;
/** Margin around the screen within which a row counts as visible, so a preview is there when it scrolls in. */
const VISIBLE_MARGIN = "100px";

/** Refusal reasons a row may carry (ChatOutbox), each with its line; any other reads as « refused ». */
const REFUSALS = new Set(["too_big", "missing", "refused", "not_found", "left", "channel"]);

/**
 * uploading: a file of the phone on its way (progress while on the wire);
 * waiting_wifi: an upload or an original held for Wi-Fi; refused: the
 * server or the outbox refused the file (error says why); downloading:
 * the original on the wire; failed_preview: the image's preview failed,
 * a tap retries; ready: shown from the phone (preview, original or the
 * file being sent); remote: nothing of it on the phone yet.
 */
export type AttachmentState =
    | "uploading" | "waiting_wifi" | "refused" | "downloading" | "failed_preview" | "ready" | "remote";

/** One file of a message as the thread shows it. */
export interface AttachmentView {
    /** `a<attachmentId>` once the file is the server's, `l<localUuid>` while on its way. */
    key: string;
    kind: AttachmentKind;
    name: string;
    size: number;
    mimetype: string;
    /** A voice message (Odoo's voice flag): the player shows the 🎤 badge. */
    voice: boolean;
    /** A file of the phone still on its way to its message. */
    outgoing: boolean;
    /** Web view URL of the local preview or original; null when none is on the phone. */
    src: string | null;
    state: AttachmentState;
    /** Percent of the transfer, null when unknown or none runs. */
    progress: number | null;
    /** What went wrong, one line; null when nothing did. */
    error: string | null;
}

/**
 * How ThreadAttachments.open ends: as ChatAttachmentCache.open, the ready
 * file with its web view URL.
 */
export type OpenOutcome = Exclude<OpenResult, { kind: "ready" }> | { kind: "ready"; path: string; url: string };

export interface ThreadAttachmentDeps {
    /** ChatService.attachments, read at each use: useFileIO makes it again. */
    cache: () => Pick<
        ChatAttachmentCache,
        "preview" | "retryPreview" | "previewFailed" | "open" | "downloadProgress" | "cancel" | "waitingWifi"
    >;
    files: () => Pick<ChatFiles, "webUrl" | "uri">;
    /** ChatOutbox.uploadProgress: bytes sent of a file on the wire, null otherwise. */
    uploadProgress: (localUuid: string) => { done: number; total: number } | null;
    /** Hands the file to Android's « open with » (ChatFile.openWith). */
    openWith: (uri: string, mimetype: string) => Promise<void>;
    /** The views may have changed in memory: the thread recomputes them (no cache read). */
    onTick: () => void;
    /** A download ended outside an open() of the screen: the thread reads the cache again. */
    onReload?: () => void;
    /**
     * The thread's scroll element, the root rows are seen within (so the
     * margin reaches past its edges); the viewport while it is unknown.
     */
    root?: () => Element | null;
}

/** How a row's files load: which rows are posts still queued, which uploads wait for Wi-Fi. */
export interface AttachmentLoad {
    pendingRows: Set<string>;
    heldUploads: Set<string>;
}

/** The part of the views a render shows: a row is rendered again only when it changes. */
export function viewSig(views: AttachmentView[]): string {
    return views.map((v) => [v.key, v.state, v.progress ?? "", v.src ?? "", v.error ?? ""].join("|")).join(",");
}

const keyOf = (a: ChatAttachment): string => (onItsWay(a) ? "l" + a.localUuid : "a" + a.attachmentId);

function percent(done: number, total: number | null): number | null {
    return total && total > 0 ? Math.min(100, Math.floor((done * 100) / total)) : null;
}

function refusalText(reason: string | null): string {
    return t("chat.att_refused_" + (reason && REFUSALS.has(reason) ? reason : "refused"));
}

/** Seconds as m:ss. */
export function clock(seconds: number): string {
    const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/**
 * The files of a thread's messages over the attachment cache, the
 * outbox's upload progress and the phone's files:
 *
 * - load() takes the rows of the shown messages (keyed as the thread's
 *   rows) and resolves the web view URL of every file on the phone; views()
 *   then computes each file's state from memory only (the cache's
 *   progress, holds and failures, the outbox's progress), so the thread can
 *   poll it cheaply.
 * - Previews are asked only for rows on screen (observe(), an
 *   IntersectionObserver), each once; the cache runs them two at a time. A
 *   file of the phone still on its way shows its own copy and asks nothing.
 * - open() fetches an original (held for Wi-Fi unless anyNetwork), openFile()
 *   hands it to « open with ».
 * - watch() polls while a file of the screen moves: PROGRESS_POLL_MS while
 *   bytes flow, WAIT_POLL_MS while a file waits to start, nothing otherwise.
 */
export class ThreadAttachments {
    source: ChatSource | null = null;
    private groups = new Map<string, ChatAttachment[]>();
    private byKey = new Map<string, ChatAttachment>();
    private rowOfKey = new Map<string, string>();
    private pendingRows = new Set<string>();
    private heldUploads = new Set<string>();
    /** Web view URL by relative path. */
    private urls = new Map<string, string>();
    /** Previews and originals fetched by this screen, by view key, until the rows record them. */
    private previewPaths = new Map<string, string>();
    private originals = new Map<string, string>();
    /** Previews asked and not answered yet. */
    private asking = new Set<string>();
    /** Images whose recorded file did not display: only what the cache answers again is shown. */
    private broken = new Set<string>();
    private opening = new Set<string>();
    private cancelled = new Set<string>();
    /** Opens of this screen that ended since the last watch(). */
    private handled = new Set<string>();
    private errors = new Map<string, string>();
    private visible = new Set<string>();
    private downloadingKeys = new Set<string>();
    private observer: IntersectionObserver | null = null;
    private observed = new WeakMap<Element, string>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private audio: HTMLAudioElement | null = null;
    private disposed = false;

    constructor(private deps: ThreadAttachmentDeps) {}

    /** Takes the files of the shown rows and resolves the URLs of those on the phone; visible rows ask their missing previews. */
    async load(groups: Map<string, ChatAttachment[]>, opts: AttachmentLoad): Promise<void> {
        const byKey = new Map<string, ChatAttachment>();
        const rowOfKey = new Map<string, string>();
        for (const [row, atts] of groups) {
            for (const a of atts) {
                byKey.set(keyOf(a), a);
                rowOfKey.set(keyOf(a), row);
            }
        }
        for (const map of [this.previewPaths, this.originals, this.errors]) {
            for (const k of [...map.keys()]) if (!byKey.has(k)) map.delete(k);
        }
        const paths = new Set<string>();
        for (const [k, a] of byKey) {
            for (const p of [a.thumbPath, a.originalPath, this.previewPaths.get(k), this.originals.get(k)]) if (p) paths.add(p);
        }
        const urls = new Map<string, string>();
        await Promise.all([...paths].map(async (p) => {
            const known = this.urls.get(p);
            if (known) urls.set(p, known);
            else {
                try {
                    urls.set(p, await this.deps.files().webUrl(p));
                } catch (e: unknown) {
                    console.warn("chat: no URL for an attachment file", e);
                }
            }
        }));
        // A preview or an original that landed during the reads keeps its URL
        for (const p of [...this.previewPaths.values(), ...this.originals.values()]) {
            const known = this.urls.get(p);
            if (known && !urls.has(p)) urls.set(p, known);
        }
        this.urls = urls;
        this.groups = groups;
        this.byKey = byKey;
        this.rowOfKey = rowOfKey;
        this.pendingRows = opts.pendingRows;
        this.heldUploads = opts.heldUploads;
        for (const row of this.visible) if (groups.has(row)) this.askPreviews(row);
    }

    /** The views of one row's files, in pick order; none for a row without files. */
    views(rowKey: string): AttachmentView[] {
        const pending = this.pendingRows.has(rowKey);
        return (this.groups.get(rowKey) ?? []).map((a) => this.viewOf(a, pending));
    }

    /** The view of one file of the screen, null when it is not shown. */
    view(key: string): AttachmentView | null {
        const a = this.byKey.get(key);
        return a ? this.viewOf(a, this.pendingRows.has(this.rowOfKey.get(key) ?? "")) : null;
    }

    /** Whether a queued post waits for Wi-Fi: one of its uploads is held and none of them is on the wire. */
    heldForWifi(rowKey: string): boolean {
        if (!this.pendingRows.has(rowKey)) return false;
        return (this.groups.get(rowKey) ?? []).some((a) =>
            onItsWay(a) && a.state !== "refused" && !!a.localUuid
            && this.heldUploads.has(a.localUuid) && !this.deps.uploadProgress(a.localUuid));
    }

    private viewOf(a: ChatAttachment, pending: boolean): AttachmentView {
        const key = keyOf(a);
        const kind = attachmentKind(a);
        const outgoing = onItsWay(a);
        let error = this.errors.get(key) ?? null;
        let state: AttachmentState;
        let progress: number | null = null;
        let src: string | null;
        if (outgoing) {
            src = this.urlOf(a.originalPath);
            if (a.state === "refused") {
                state = "refused";
                error = refusalText(a.error);
            } else if (!pending) {
                // A post that failed: its files stay on the phone beside it
                state = "ready";
            } else {
                const p = a.localUuid ? this.deps.uploadProgress(a.localUuid) : null;
                if (p) {
                    state = "uploading";
                    progress = percent(p.done, p.total);
                } else {
                    state = a.localUuid && this.heldUploads.has(a.localUuid) ? "waiting_wifi" : "uploading";
                }
            }
        } else {
            const cache = this.deps.cache();
            const original = this.originals.get(key) ?? (this.broken.has(key) ? null : a.originalPath);
            const thumb = this.previewPaths.get(key) ?? (this.broken.has(key) ? null : a.thumbPath);
            src = kind === "image" ? this.urlOf(thumb) ?? this.urlOf(original) : this.urlOf(original);
            const d = cache.downloadProgress(a);
            if (d || this.opening.has(key)) {
                state = "downloading";
                progress = d ? percent(d.done, d.total) : null;
            } else if (cache.waitingWifi(a)) {
                state = "waiting_wifi";
            } else if (kind === "image" && !src && cache.previewFailed(a)) {
                state = "failed_preview";
            } else {
                state = src ? "ready" : "remote";
            }
        }
        return {
            key, kind, name: a.name, size: a.size, mimetype: a.mimetype, voice: a.voice, outgoing,
            src, state, progress, error,
        };
    }

    private urlOf(path: string | null | undefined): string | null {
        return path ? this.urls.get(path) ?? null : null;
    }

    private async ensureUrl(path: string): Promise<string> {
        let url = this.urls.get(path);
        if (!url) {
            url = await this.deps.files().webUrl(path);
            this.urls.set(path, url);
        }
        return url;
    }

    // ─── Visibility and previews ──────────────────────────────────────────

    /**
     * Follows el (a row's files) on screen; without IntersectionObserver
     * the row counts as seen at once.
     */
    observe(el: Element, rowKey: string): void {
        if (this.disposed) return;
        if (typeof IntersectionObserver === "undefined") {
            this.seen(rowKey);
            return;
        }
        if (!this.observer) {
            this.observer = new IntersectionObserver((entries) => {
                for (const e of entries) {
                    const row = this.observed.get(e.target);
                    if (!row) continue;
                    if (e.isIntersecting) this.seen(row);
                    else this.visible.delete(row);
                }
            }, { root: this.deps.root?.() ?? null, rootMargin: VISIBLE_MARGIN });
        }
        this.observed.set(el, rowKey);
        this.observer.observe(el);
    }

    unobserve(el: Element): void {
        this.observer?.unobserve(el);
        this.observed.delete(el);
    }

    /** A row came on screen: its images without a preview on the phone ask the cache for one. */
    seen(rowKey: string): void {
        this.visible.add(rowKey);
        this.askPreviews(rowKey);
    }

    private askPreviews(rowKey: string): void {
        const src = this.source;
        if (!src || this.disposed) return;
        const cache = this.deps.cache();
        for (const a of this.groups.get(rowKey) ?? []) {
            if (attachmentKind(a) !== "image" || onItsWay(a)) continue;
            const key = keyOf(a);
            if (this.asking.has(key) || this.previewPaths.has(key) || this.originals.has(key)) continue;
            if (!this.broken.has(key) && (a.thumbPath || a.originalPath)) continue;
            if (cache.previewFailed(a)) continue;
            this.asking.add(key);
            cache.preview(src, a).then((p) => this.gotPreview(key, p), () => this.gotPreview(key, null));
        }
    }

    private async gotPreview(key: string, path: string | null): Promise<void> {
        if (path) {
            try {
                await this.ensureUrl(path);
                this.previewPaths.set(key, path);
            } catch (e: unknown) {
                console.warn("chat: no URL for a preview", e);
            }
        }
        this.asking.delete(key);
        this.changed();
    }

    /** Forgets a failed preview and asks it again (the placeholder's tap). */
    async retryPreview(key: string): Promise<void> {
        const a = this.byKey.get(key);
        if (!a || !this.source || this.asking.has(key)) return;
        this.asking.add(key);
        this.changed();
        let path: string | null = null;
        try {
            path = await this.deps.cache().retryPreview(this.source, a);
        } catch (e: unknown) {
            console.warn("chat: preview retry failed", e);
        }
        await this.gotPreview(key, path);
    }

    /** An image whose file did not display (removed meanwhile): asked once again of the cache, which checks it. */
    broke(key: string): void {
        if (this.broken.has(key)) return;
        this.broken.add(key);
        this.previewPaths.delete(key);
        this.originals.delete(key);
        const row = this.rowOfKey.get(key);
        if (row && this.visible.has(row)) this.askPreviews(row);
        this.changed();
    }

    // ─── Originals ────────────────────────────────────────────────────────

    /**
     * The file's original through the cache (held for Wi-Fi unless
     * anyNetwork, that file only); while it runs the view reads
     * « downloading ». Gone or failed sets the view's error; a failure
     * after cancel() sets none.
     */
    async open(key: string, opts: { anyNetwork?: boolean } = {}): Promise<OpenOutcome> {
        const a = this.byKey.get(key);
        const src = this.source;
        if (!a || !src) return { kind: "failed" };
        this.errors.delete(key);
        this.cancelled.delete(key);
        this.opening.add(key);
        this.changed();
        let r: OpenResult;
        try {
            r = await this.deps.cache().open(src, a, opts.anyNetwork ? { anyNetwork: true } : {});
        } catch (e: unknown) {
            console.warn("chat: attachment not opened", e);
            r = { kind: "failed" };
        } finally {
            this.opening.delete(key);
            this.handled.add(key);
        }
        let out: OpenOutcome = r as OpenOutcome;
        if (r.kind === "ready") {
            try {
                const url = await this.ensureUrl(r.path);
                if (!onItsWay(a)) this.originals.set(key, r.path);
                out = { kind: "ready", path: r.path, url };
            } catch (e: unknown) {
                console.warn("chat: no URL for an original", e);
                out = { kind: "failed" };
            }
        }
        if (out.kind === "gone") this.errors.set(key, t("chat.att_gone"));
        else if (out.kind === "failed" && !this.cancelled.has(key)) this.errors.set(key, t("chat.att_failed"));
        this.cancelled.delete(key);
        this.changed();
        return out;
    }

    /** open(), then the original goes to Android's « open with » under its mimetype. */
    async openFile(key: string, opts: { anyNetwork?: boolean } = {}): Promise<void> {
        const r = await this.open(key, opts);
        const a = this.byKey.get(key);
        if (r.kind !== "ready" || !a) return;
        try {
            await this.deps.openWith(await this.deps.files().uri(r.path), a.mimetype || "application/octet-stream");
        } catch (e: unknown) {
            const code = (e as { code?: unknown } | null)?.code;
            this.errors.set(key, t(code === CHAT_FILE_NO_APP ? "chat.att_no_app" : "chat.att_open_failed"));
            this.changed();
        }
    }

    /** Stops the original's download (no error follows) and its Wi-Fi hold. */
    async cancel(key: string): Promise<void> {
        const a = this.byKey.get(key);
        if (!a) return;
        this.cancelled.add(key);
        await this.deps.cache().cancel(a);
        this.changed();
    }

    /** Files whose audio the web view could not play, by key. */
    private unplayed = new Set<string>();

    /** The web view could not play this file: its view says so, and unplayable() is true for it. */
    cannotPlay(key: string): void {
        this.unplayed.add(key);
        this.errors.set(key, t("chat.att_play_failed"));
        this.changed();
    }

    unplayable(key: string): boolean {
        return this.unplayed.has(key);
    }

    /** One player at a time: the one starting pauses the one before. */
    playing(audio: HTMLAudioElement): void {
        if (this.audio && this.audio !== audio) this.audio.pause();
        this.audio = audio;
    }

    // ─── Polling ──────────────────────────────────────────────────────────

    /**
     * Called after each render of the rows: schedules the next tick by what
     * moves (PROGRESS_POLL_MS, WAIT_POLL_MS or none), and asks for a cache
     * read when a download this screen did not start has ended.
     */
    watch(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (this.disposed) return;
        let fast = false;
        let slow = false;
        const down = new Set<string>();
        for (const row of this.groups.keys()) {
            for (const v of this.views(row)) {
                if (v.state === "downloading") {
                    fast = true;
                    down.add(v.key);
                } else if (v.state === "uploading") {
                    if (v.progress !== null) fast = true;
                    else slow = true;
                } else if (v.state === "waiting_wifi") {
                    slow = true;
                }
            }
        }
        const ended = [...this.downloadingKeys].some((k) => !down.has(k) && !this.handled.has(k));
        this.downloadingKeys = down;
        this.handled.clear();
        if (ended) this.deps.onReload?.();
        if (fast || slow) {
            this.timer = setTimeout(() => {
                this.timer = null;
                if (!this.disposed) this.deps.onTick();
            }, fast ? PROGRESS_POLL_MS : WAIT_POLL_MS);
        }
    }

    /** Stops the polling, the observer and the player; later answers change nothing. */
    dispose(): void {
        this.disposed = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.observer?.disconnect();
        this.observer = null;
        this.audio?.pause();
    }

    private changed(): void {
        if (!this.disposed) this.deps.onTick();
    }
}

/**
 * The files of one message: images as a grid (one image in a fixed box,
 * several as tiles), voice and audio as player rows, other files as chips.
 * A tap on an image opens the viewer (onImage), on a failed preview
 * retries it; a file opens through « open with »; a held file offers
 * « download anyway ».
 */
export class ChatAttachmentsComponent extends EnhancedComponent {
    static props = { row: Object, ta: Object, onImage: Function };

    static template = xml`
    <div class="chat-att" t-ref="root">
      <div t-if="images().length" class="chat-att__grid" t-att-class="{'chat-att__grid--single': images().length === 1}">
        <button t-foreach="images()" t-as="v" t-key="v.key" class="chat-att__tile"
                t-att-class="{'chat-att__tile--failed': v.state === 'failed_preview'}"
                t-att-aria-label="tileLabel(v)"
                t-on-click="() => this.onImage(v)">
          <img t-if="v.src" class="chat-att__img" t-att-src="v.src" t-att-alt="v.name" t-on-error="() => this.props.ta.broke(v.key)"/>
          <span t-elif="v.state === 'failed_preview'" class="chat-att__placeholder" aria-hidden="true">↻</span>
          <span t-else="" class="chat-att__placeholder" aria-hidden="true">🖼️</span>
          <span t-if="v.state === 'uploading' or v.state === 'downloading'" class="chat-att__progress" t-esc="transferText(v)"/>
          <span t-if="v.state === 'waiting_wifi'" class="chat-att__progress" t-esc="'⏳ ' + t('chat.waiting_wifi')"/>
        </button>
      </div>
      <t t-foreach="images()" t-as="v" t-key="v.key">
        <p t-if="v.error" class="chat-att__error" role="alert" t-esc="v.name + ' — ' + v.error"/>
      </t>
      <div t-foreach="voices()" t-as="v" t-key="v.key" class="chat-att__voice">
        <button class="chat-att__play" t-att-disabled="v.state === 'refused' or v.state === 'downloading'"
                t-att-aria-label="playLabel(v)"
                t-on-click="() => this.onToggle(v)" t-esc="player.playing[v.key] ? '⏸' : '▶'"/>
        <span t-if="v.voice" class="chat-att__badge" t-att-title="t('chat.voice_message')" aria-hidden="true">🎤</span>
        <span t-else="" class="chat-att__name" t-esc="'🎵 ' + v.name"/>
        <span class="chat-att__clock" t-esc="clockText(v)"/>
        <span t-if="v.state === 'uploading' or v.state === 'downloading'" class="chat-att__state" t-esc="transferText(v)"/>
        <button t-if="v.state === 'downloading'" class="chat-att__cancel" t-att-aria-label="t('chat.att_cancel', {name: v.name})"
                t-on-click="() => this.onCancel(v)">✕</button>
        <t t-if="v.state === 'waiting_wifi'">
          <span class="chat-att__state" t-esc="'⏳ ' + t('chat.waiting_wifi')"/>
          <button t-if="!v.outgoing" class="chat-att__anyway" t-on-click="() => this.onAnyway(v)" t-esc="t('chat.download_anyway')"/>
        </t>
        <span t-if="v.error" class="chat-att__error" role="alert" t-esc="v.error"/>
        <button t-if="canOpenWith(v)" class="chat-att__anyway" t-on-click="() => this.onFile(v)" t-esc="t('chat.open_with')"/>
        <audio class="chat-att__audio" preload="metadata" t-att-data-key="v.key"
               t-on-loadedmetadata="(ev) => this.onAudio(ev, v.key)" t-on-durationchange="(ev) => this.onAudio(ev, v.key)"
               t-on-timeupdate="(ev) => this.onAudio(ev, v.key)" t-on-playing="(ev) => this.onAudio(ev, v.key)"
               t-on-pause="(ev) => this.onAudio(ev, v.key)" t-on-ended="(ev) => this.onAudio(ev, v.key)"
               t-on-error="(ev) => this.onAudio(ev, v.key)"/>
      </div>
      <div t-foreach="files()" t-as="v" t-key="v.key" class="chat-att__file">
        <button class="chat-att__open" t-att-disabled="v.state === 'refused'" t-on-click="() => this.onFile(v)">
          <span aria-hidden="true">📎</span>
          <span class="chat-att__name" t-esc="v.name"/>
          <span class="chat-att__size" t-esc="sizeText(v)"/>
        </button>
        <span t-if="v.state === 'uploading' or v.state === 'downloading'" class="chat-att__state" t-esc="transferText(v)"/>
        <button t-if="v.state === 'downloading'" class="chat-att__cancel" t-att-aria-label="t('chat.att_cancel', {name: v.name})"
                t-on-click="() => this.onCancel(v)">✕</button>
        <t t-if="v.state === 'waiting_wifi'">
          <span class="chat-att__state" t-esc="'⏳ ' + t('chat.waiting_wifi')"/>
          <button t-if="!v.outgoing" class="chat-att__anyway" t-on-click="() => this.onAnyway(v)" t-esc="t('chat.download_anyway')"/>
        </t>
        <span t-if="v.error" class="chat-att__error" role="alert" t-esc="v.error"/>
      </div>
    </div>`;

    root!: { el: HTMLElement | null };
    player!: { playing: Record<string, boolean>; position: Record<string, number>; duration: Record<string, number> };
    private _el: HTMLElement | null = null;

    setup() {
        this.root = useRef("root") as { el: HTMLElement | null };
        this.player = useState({ playing: {}, position: {}, duration: {} });
        onMounted(() => {
            this._el = this.root.el;
            if (this._el) this.ta.observe(this._el, this.props.row.key);
            this.syncSources();
        });
        onPatched(() => this.syncSources());
        onWillUnmount(() => {
            if (this._el) this.ta.unobserve(this._el);
        });
    }

    get ta(): ThreadAttachments {
        return this.props.ta as ThreadAttachments;
    }

    private all(): AttachmentView[] {
        return (this.props.row.attachments ?? []) as AttachmentView[];
    }

    images(): AttachmentView[] {
        return this.all().filter((v) => v.kind === "image");
    }

    voices(): AttachmentView[] {
        return this.all().filter((v) => v.kind === "voice");
    }

    files(): AttachmentView[] {
        return this.all().filter((v) => v.kind === "file");
    }

    sizeText(v: AttachmentView): string {
        return formatBytes(v.size, getCurrentLocale());
    }

    /** « ↑ 25 % » while sending, « ↓ 25 % » while downloading; « … » while the share is unknown. */
    transferText(v: AttachmentView): string {
        const amount = v.progress === null ? "…" : t("chat.att_progress", { percent: v.progress });
        return (v.state === "uploading" ? "↑ " : "↓ ") + amount;
    }

    /**
     * The player's position, over the duration once known; « –:–– » while
     * neither is known and the file is not on the phone (no source to read
     * them from), rather than a « 0:00 » that reads as an empty recording.
     */
    clockText(v: Pick<AttachmentView, "key" | "src">): string {
        const duration = this.player.duration[v.key];
        const known = !!duration && Number.isFinite(duration);
        if (!known && !v.src && !this.player.position[v.key]) return "–:––";
        const position = clock(this.player.position[v.key] ?? 0);
        return known ? position + " / " + clock(duration) : position;
    }

    /** An image tile's label: its name, then its state when it has one (screen readers read no inner text). */
    tileLabel(v: AttachmentView): string {
        if (v.state === "failed_preview") return t("chat.att_retry_preview", { name: v.name });
        let state = "";
        if (v.state === "uploading" || v.state === "downloading") {
            state = t(v.state === "uploading" ? "chat.att_sending" : "chat.att_downloading");
            if (v.progress !== null) state += ", " + t("chat.att_progress", { percent: v.progress });
        } else if (v.state === "waiting_wifi") {
            state = t("chat.waiting_wifi");
        } else if (v.error) {
            state = v.error;
        }
        return state ? v.name + " — " + state : v.name;
    }

    /** « Open with » beside an audio file the web view could not play; a voice message is Odoo's MP3 and plays here. */
    canOpenWith(v: AttachmentView): boolean {
        return !v.voice && this.ta.unplayable(v.key);
    }

    onImage(v: AttachmentView): void {
        if (v.state === "failed_preview") {
            void this.ta.retryPreview(v.key);
            return;
        }
        this.props.onImage(v.key);
    }

    onFile(v: AttachmentView): void {
        if (v.state === "downloading" || v.state === "refused") return;
        void this.ta.openFile(v.key);
    }

    async onCancel(v: AttachmentView): Promise<void> {
        await this.ta.cancel(v.key);
    }

    /** « Download anyway »: that file now, whatever the network; a voice then plays, a file opens. */
    async onAnyway(v: AttachmentView): Promise<void> {
        if (v.kind === "voice") return this.play(v, true);
        if (v.kind === "file") return this.ta.openFile(v.key, { anyNetwork: true });
        this.props.onImage(v.key);
    }

    async onToggle(v: AttachmentView): Promise<void> {
        const audio = this.audioOf(v.key);
        if (audio && !audio.paused) {
            audio.pause();
            return;
        }
        await this.play(v, false);
    }

    /** The play button's label: what plays, the voice message or the file's name. */
    playLabel(v: AttachmentView): string {
        const name = v.voice ? t("chat.att_voice_name") : v.name;
        return t(this.player.playing[v.key] ? "chat.att_pause" : "chat.att_play", { name });
    }

    /**
     * Gives each player whose file is on the phone its source, once: the
     * template never binds src, so a render can never reload a player that
     * is starting or playing (setting src restarts the media load).
     */
    syncSources(): void {
        for (const v of this.voices()) {
            if (!v.src) continue;
            const audio = this.audioOf(v.key);
            if (audio) this.setSource(audio, v.src);
        }
    }

    private setSource(audio: HTMLAudioElement, url: string): void {
        if (audio.getAttribute("src") !== url) audio.src = url;
    }

    /**
     * Plays the file from the phone, its original fetched first when none is
     * there; « playing » then follows the audio's own events.
     */
    async play(v: AttachmentView, anyNetwork: boolean): Promise<void> {
        let url = v.src;
        if (!url) {
            const r = await this.ta.open(v.key, anyNetwork ? { anyNetwork: true } : {});
            if (r.kind !== "ready") return;
            url = r.url;
        }
        const audio = this.audioOf(v.key);
        if (!audio) return;
        this.setSource(audio, url);
        this.ta.playing(audio);
        try {
            await audio.play();
        } catch (e: unknown) {
            console.warn("chat: audio did not play", e);
            if ((e as { name?: unknown } | null)?.name === "NotSupportedError") this.ta.cannotPlay(v.key);
        }
    }

    audioOf(key: string): HTMLAudioElement | null {
        return (this.root.el?.querySelector('audio[data-key="' + key + '"]') as HTMLAudioElement | null) ?? null;
    }

    onAudio(ev: Event, key: string): void {
        const audio = ev.target as HTMLAudioElement;
        if (ev.type === "loadedmetadata" || ev.type === "durationchange") this.player.duration[key] = audio.duration;
        else if (ev.type === "timeupdate") this.player.position[key] = audio.currentTime;
        else if (ev.type === "playing") this.player.playing[key] = true;
        else if (ev.type === "pause") this.player.playing[key] = false;
        else if (ev.type === "error") {
            this.player.playing[key] = false;
            // A source the web view cannot decode; an audio without one has nothing to say
            if (audio.getAttribute("src")) this.ta.cannotPlay(key);
        }
        else if (ev.type === "ended") {
            this.player.playing[key] = false;
            this.player.position[key] = 0;
        }
    }
}
