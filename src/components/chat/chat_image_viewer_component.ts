import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { t } from "../../i18n";
import { PROGRESS_POLL_MS, type ThreadAttachments } from "./chat_attachments_component";

/** loading: the original is asked (downloading, or read from the phone); the other stages as OpenResult. */
type ViewerStage = "loading" | "waiting_wifi" | "ready" | "gone" | "failed";

interface ViewerState {
    /** What is shown: the preview at first, the original once it is on the phone. */
    url: string | null;
    stage: ViewerStage;
    /** Percent of the original received, null while unknown. */
    progress: number | null;
}

/**
 * One image over the whole screen: its preview at once, then its original
 * (ThreadAttachments.open, so Wi-Fi only holds it). Held for Wi-Fi, it
 * offers « download anyway » for that image alone, and asks again by
 * itself once the hold ends (the cache took the file on Wi-Fi). Closing
 * leaves a download running: the original lands in the cache.
 *
 * The viewer holds its own history entry (same URL), so Android's back
 * closes it rather than the conversation; ✕ goes back over that entry.
 */
export class ChatImageViewerComponent extends EnhancedComponent {
    static props = { ta: Object, attKey: String, onClose: Function };

    static template = xml`
    <div class="chat-viewer" role="dialog" aria-modal="true" t-att-aria-label="name()">
      <button class="chat-viewer__close" t-att-aria-label="t('chat.viewer_close')" t-on-click="() => this.onClose()">✕</button>
      <img t-if="state.url" class="chat-viewer__img" t-att-src="state.url" t-att-alt="name()"/>
      <p t-if="state.stage === 'loading'" class="chat-viewer__status" role="status" t-esc="loadingText()"/>
      <div t-if="state.stage === 'waiting_wifi'" class="chat-viewer__status" role="status">
        <span t-esc="'⏳ ' + t('chat.waiting_wifi')"/>
        <button class="chat-viewer__anyway" t-on-click="() => this.onAnyway()" t-esc="t('chat.download_anyway')"/>
      </div>
      <p t-if="state.stage === 'gone'" class="chat-viewer__status" role="alert" t-esc="t('chat.att_gone')"/>
      <div t-if="state.stage === 'failed'" class="chat-viewer__status" role="alert">
        <span t-esc="t('chat.att_failed')"/>
        <button class="chat-viewer__anyway" t-on-click="() => this.load()" t-esc="t('chat.retry')"/>
      </div>
    </div>`;

    state!: ViewerState;
    private _poll: ReturnType<typeof setInterval> | null = null;
    private _closed = false;
    /** The viewer's history entry is the current one. */
    private _inHistory = false;
    /** ✕ went back over the entry: its popstate is on its way, a second ✕ waits for it. */
    private _closing = false;
    private _onPop = () => {
        if (!this._inHistory) return;
        this._inHistory = false;
        this.props.onClose();
    };

    setup() {
        this.state = useState<ViewerState>({
            url: this.ta.view(this.props.attKey)?.src ?? null,
            stage: "loading",
            progress: null,
        });
        onMounted(() => this.onOpened());
        onWillUnmount(() => this.onClosing());
    }

    /** Shown: takes a history entry and asks its original. */
    onOpened(): void {
        window.history.pushState({ ...(window.history.state ?? {}), chatViewer: true }, "");
        this._inHistory = true;
        window.addEventListener("popstate", this._onPop);
        void this.load();
    }

    /**
     * Gone from the screen: stops following. Removed while its entry is
     * still the current one (the thread went away without a back), the
     * entry loses its mark, so no later back is taken for the viewer's; an
     * entry the screen moved to is left alone.
     */
    onClosing(): void {
        this._closed = true;
        window.removeEventListener("popstate", this._onPop);
        this.stopPoll();
        const current = window.history.state;
        if (this._inHistory && current?.chatViewer) {
            const rest = { ...current };
            delete rest.chatViewer;
            window.history.replaceState(rest, "");
        }
        this._inHistory = false;
    }

    get ta(): ThreadAttachments {
        return this.props.ta as ThreadAttachments;
    }

    name(): string {
        return this.ta.view(this.props.attKey)?.name ?? "";
    }

    loadingText(): string {
        const p = this.state.progress;
        return t("chat.viewer_loading") + (p === null ? "" : " " + t("chat.att_progress", { percent: p }));
    }

    /** Asks the original (anyNetwork: now, whatever the network); the preview stays until it is there. */
    async load(anyNetwork = false): Promise<void> {
        this.state.stage = "loading";
        this.state.progress = null;
        this.startPoll();
        const r = await this.ta.open(this.props.attKey, anyNetwork ? { anyNetwork: true } : {});
        if (this._closed) return;
        if (r.kind === "ready") {
            this.state.url = r.url;
            this.state.stage = "ready";
        } else {
            this.state.stage = r.kind;
        }
        // Only a hold still has something to wait for
        if (this.state.stage !== "waiting_wifi") this.stopPoll();
    }

    onAnyway(): Promise<void> {
        return this.load(true);
    }

    /**
     * ✕: back over the viewer's entry (popstate closes it), or closes at
     * once without one; a ✕ while that back is on its way does nothing, so
     * a double tap never leaves the conversation.
     */
    onClose(): void {
        if (this._closing) return;
        if (this._inHistory) {
            this._closing = true;
            window.history.back();
        } else {
            this.props.onClose();
        }
    }

    /**
     * From memory only, every PROGRESS_POLL_MS while the original is asked
     * or held: the percent while loading; while held, a hold that ended
     * (the cache took the file on Wi-Fi) asks the original again, which
     * joins that download.
     */
    private startPoll(): void {
        this.stopPoll();
        this._poll = setInterval(() => {
            const v = this.ta.view(this.props.attKey);
            if (this.state.stage === "loading") this.state.progress = v?.progress ?? null;
            else if (this.state.stage === "waiting_wifi" && v && v.state !== "waiting_wifi") void this.load();
        }, PROGRESS_POLL_MS);
    }

    private stopPoll(): void {
        if (this._poll !== null) clearInterval(this._poll);
        this._poll = null;
    }
}
