import { onMounted, onWillUnmount, useRef, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import type { ChatAvatar } from "../../models/chat";
import type { ChatAvatars } from "../../services/chat/chatAvatars";
import type { ChatFiles } from "../../services/chat/chatFiles";
import type { ChatSource } from "../../services/chat/chatSources";

/** How far past the scroll area's edges a row counts as on screen. */
const VISIBLE_MARGIN = "100px";

/**
 * The author over the first bubble of a run: the name shown, its initials
 * on a background of the partner's hue, and the web view URL of the cached
 * avatar (null while there is none: the initials show). partnerId is null
 * for an author the phone has no partner of (a guest).
 */
export interface AuthorView {
    partnerId: number | null;
    name: string;
    initials: string;
    hue: number;
    avatar: string | null;
}

export interface ThreadAvatarDeps {
    /** ChatService.avatars, read at each use: useFileIO makes it again. */
    avatars: () => Pick<ChatAvatars, "fetch">;
    /** The account's cached avatars (ChatRepository.avatars). */
    cached: (configId: string) => Promise<ChatAvatar[]>;
    files: () => Pick<ChatFiles, "webUrl">;
    /** An avatar landed or stopped displaying: the thread recomputes its rows from memory. */
    onTick: () => void;
    /** The thread's scroll element, the root rows are seen within; the viewport while it is unknown. */
    root?: () => Element | null;
}

/**
 * The avatars of one thread screen over ChatAvatars:
 *
 * - load() takes the authors' current keys (their write dates) and the
 *   account's cached avatars, and resolves their web view URLs; url() then
 *   answers from memory. A cached avatar shows whatever its key, until a
 *   newer one lands.
 * - An avatar is asked only for an author on screen (observe(), an
 *   IntersectionObserver), and only when the cached one is missing, of
 *   another key, or did not display; each partner and key once per screen,
 *   so a failure stays initials until the conversation opens again.
 */
export class ThreadAvatars {
    source: ChatSource | null = null;
    private keys = new Map<number, string>();
    private rows = new Map<number, ChatAvatar>();
    /** Avatars this screen fetched, until the cache's rows have them. */
    private fetched = new Map<number, ChatAvatar>();
    private urls = new Map<string, string>();
    /** `partnerId#key` already asked by this screen. */
    private asked = new Set<string>();
    /** Paths whose image did not display. */
    private failed = new Set<string>();
    private visible = new Set<number>();
    private observer: IntersectionObserver | null = null;
    private observed = new WeakMap<Element, number>();
    private disposed = false;

    constructor(private deps: ThreadAvatarDeps) {}

    /** Takes the authors' keys and the account's cached avatars; authors on screen ask what they miss. */
    async load(configId: string, keys: Map<number, string>): Promise<void> {
        const rows = new Map((await this.deps.cached(configId)).map((a) => [a.partnerId, a]));
        for (const [partnerId, a] of this.fetched) rows.set(partnerId, a);
        const urls = new Map<string, string>();
        await Promise.all([...rows.values()].map(async (a) => {
            const known = this.urls.get(a.path);
            if (known) urls.set(a.path, known);
            else {
                try {
                    urls.set(a.path, await this.deps.files().webUrl(a.path));
                } catch (e: unknown) {
                    console.warn("chat: no URL for an avatar", e);
                }
            }
        }));
        if (this.disposed) return;
        this.keys = keys;
        this.rows = rows;
        this.urls = urls;
        for (const partnerId of this.visible) this.seen(partnerId);
    }

    /** The web view URL of the partner's avatar on the phone, null while there is none to show. */
    url(partnerId: number): string | null {
        const a = this.rows.get(partnerId);
        if (!a || this.failed.has(a.path)) return null;
        return this.urls.get(a.path) ?? null;
    }

    /** Follows el (an author's avatar) on screen; without IntersectionObserver it counts as seen at once. */
    observe(el: Element, partnerId: number): void {
        if (this.disposed) return;
        if (typeof IntersectionObserver === "undefined") {
            this.seen(partnerId);
            return;
        }
        if (!this.observer) {
            this.observer = new IntersectionObserver((entries) => {
                for (const e of entries) {
                    const partner = this.observed.get(e.target);
                    if (partner === undefined) continue;
                    if (e.isIntersecting) this.seen(partner);
                    else this.visible.delete(partner);
                }
            }, { root: this.deps.root?.() ?? null, rootMargin: VISIBLE_MARGIN });
        }
        this.observed.set(el, partnerId);
        this.observer.observe(el);
    }

    unobserve(el: Element): void {
        this.observer?.unobserve(el);
        this.observed.delete(el);
    }

    /** An author came on screen: its avatar is fetched unless the one cached has its key and displays. */
    seen(partnerId: number): void {
        if (this.disposed) return;
        this.visible.add(partnerId);
        const key = this.keys.get(partnerId) ?? "";
        const a = this.rows.get(partnerId);
        if (a && a.uniqueKey === key && !this.failed.has(a.path)) return;
        const ask = `${partnerId}#${key}`;
        if (this.asked.has(ask) || !this.source) return;
        this.asked.add(ask);
        const src = this.source;
        void this.deps.avatars().fetch(src, partnerId, key).then(async (path) => {
            if (!path || this.disposed) return;
            const url = await this.deps.files().webUrl(path);
            if (this.disposed) return;
            const row: ChatAvatar = {
                configId: src.configId, partnerId, uniqueKey: key, path, bytes: 0, fetchedAt: "",
            };
            this.fetched.set(partnerId, row);
            this.rows.set(partnerId, row);
            this.urls.set(path, url);
            this.failed.delete(path);
            this.deps.onTick();
        }).catch((e: unknown) => console.warn("chat: avatar not shown", e));
    }

    /** The partner's image did not display (its file gone): initials, and the avatar is asked again. */
    broken(partnerId: number): void {
        const a = this.rows.get(partnerId);
        if (!a || this.disposed) return;
        this.failed.add(a.path);
        this.deps.onTick();
        if (this.visible.has(partnerId)) this.seen(partnerId);
    }

    /** Stops the observer; later answers change nothing. */
    dispose(): void {
        this.disposed = true;
        this.observer?.disconnect();
        this.observer = null;
    }
}

/**
 * The round avatar of a run's author: the cached image, else the initials
 * on the partner's hue. Hidden from screen readers: the name beside it is
 * the text. Asks ThreadAvatars for the image once on screen.
 */
export class ChatAvatarComponent extends EnhancedComponent {
    static template = xml`
    <span class="chat-thread__author-avatar" aria-hidden="true" t-ref="root"
          t-att-style="'background-color: hsl(' + props.author.hue + ', 40%, 42%)'">
      <img t-if="props.author.avatar" class="chat-thread__author-img" t-att-src="props.author.avatar" alt=""
           decoding="async" width="32" height="32" t-on-error="onError"/>
      <t t-else="" t-esc="props.author.initials"/>
    </span>`;

    private _el: HTMLElement | null = null;

    setup() {
        const root = useRef("root") as { el: HTMLElement | null };
        onMounted(() => {
            this._el = root.el;
            const id = this.props.author.partnerId;
            if (this._el && id !== null) this.avatars.observe(this._el, id);
        });
        onWillUnmount(() => {
            if (this._el) this.avatars.unobserve(this._el);
        });
    }

    get avatars(): ThreadAvatars {
        return this.props.avatars as ThreadAvatars;
    }

    onError(): void {
        const id = this.props.author.partnerId;
        if (id !== null) this.avatars.broken(id);
    }
}
