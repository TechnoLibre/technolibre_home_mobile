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
 * offers « download anyway » for that image alone. Closing leaves a
 * download running: the original lands in the cache.
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

    setup() {
        this.state = useState<ViewerState>({
            url: this.ta.view(this.props.attKey)?.src ?? null,
            stage: "loading",
            progress: null,
        });
        onMounted(() => void this.load());
        onWillUnmount(() => {
            this._closed = true;
            this.stopPoll();
        });
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
        this.startPoll();
        const r = await this.ta.open(this.props.attKey, anyNetwork ? { anyNetwork: true } : {});
        this.stopPoll();
        if (this._closed) return;
        if (r.kind === "ready") {
            this.state.url = r.url;
            this.state.stage = "ready";
        } else {
            this.state.stage = r.kind;
        }
    }

    onAnyway(): Promise<void> {
        return this.load(true);
    }

    onClose(): void {
        this.props.onClose();
    }

    private startPoll(): void {
        this.stopPoll();
        this._poll = setInterval(() => {
            this.state.progress = this.ta.view(this.props.attKey)?.progress ?? null;
        }, PROGRESS_POLL_MS);
    }

    private stopPoll(): void {
        if (this._poll !== null) clearInterval(this._poll);
        this._poll = null;
    }
}
