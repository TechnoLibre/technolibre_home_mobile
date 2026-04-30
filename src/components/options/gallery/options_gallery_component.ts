import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";
import { Capacitor } from "@capacitor/core";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";
import { GalleryService, GalleryImage } from "../../../services/galleryService";

import { HeadingComponent } from "../../heading/heading_component";

interface State {
    images:        GalleryImage[];
    loading:       boolean;
    /** -1 = mosaic view; otherwise index into images for fullscreen. */
    fullscreenIdx: number;
    error:         string;
    /** CSS transform driving the fullscreen image — scale from 1 (fit
     *  screen) up to MAX_SCALE; tx/ty are pixels of pan applied on top
     *  of the scale. Reactive so the inline style updates as the user
     *  pinches / pans. */
    scale:         number;
    tx:            number;
    ty:            number;
}

export class OptionsGalleryComponent extends EnhancedComponent {
    static template = xml`
        <div id="options-gallery-component">
            <HeadingComponent title="'Options › Galerie'" backUrl="'/options'"/>

            <div t-if="state.loading" class="gallery__status">
                Chargement…
            </div>

            <div t-elif="state.error" class="gallery__status gallery__status--error">
                <t t-esc="state.error"/>
            </div>

            <div t-elif="state.images.length === 0" class="gallery__status">
                Aucune image dans les notes pour l'instant.
            </div>

            <!-- ── Mosaic ───────────────────────────────────────────── -->
            <div t-elif="state.fullscreenIdx === -1" class="gallery__mosaic"
                 aria-label="Mosaïque d'images">
                <button t-foreach="state.images" t-as="img" t-key="img.entryId"
                        class="gallery__tile"
                        t-att-aria-label="'Ouvrir : ' + (img.noteTitle || 'note sans titre')"
                        t-on-click="() => this.openFullscreen(img_index)">
                    <img t-att-src="webPath(img.path)" alt=""/>
                </button>
            </div>

            <!-- ── Fullscreen carousel ─────────────────────────────── -->
            <div t-else=""
                 class="gallery__viewer"
                 t-on-touchstart="onTouchStart"
                 t-on-touchmove="onTouchMove"
                 t-on-touchend="onTouchEnd"
                 t-on-touchcancel="onTouchEnd"
                 aria-label="Visionneuse plein écran">
                <button class="gallery__viewer__btn gallery__viewer__btn--close"
                        aria-label="Retour à la mosaïque"
                        t-on-click="closeFullscreen">×</button>
                <button class="gallery__viewer__btn gallery__viewer__btn--prev"
                        t-att-disabled="state.fullscreenIdx === 0 ? 'true' : null"
                        aria-label="Image précédente"
                        t-on-click="prev">‹</button>
                <button class="gallery__viewer__btn gallery__viewer__btn--next"
                        t-att-disabled="state.fullscreenIdx >= state.images.length - 1 ? 'true' : null"
                        aria-label="Image suivante"
                        t-on-click="next">›</button>
                <img class="gallery__viewer__img"
                     t-att-src="webPath(state.images[state.fullscreenIdx].path)"
                     t-att-alt="state.images[state.fullscreenIdx].noteTitle"
                     t-att-style="imageTransform"/>
                <div class="gallery__viewer__caption">
                    <span class="gallery__viewer__title"
                          t-esc="state.images[state.fullscreenIdx].noteTitle || 'Sans titre'"/>
                    <span class="gallery__viewer__counter"
                          t-esc="(state.fullscreenIdx + 1) + ' / ' + state.images.length"/>
                </div>
            </div>
        </div>
    `;

    static components = { HeadingComponent };

    state!: State;
    private _gallery!: GalleryService;
    /** Gesture-machine state. Refs (not reactive) so a 60 fps stream of
     *  touchmove deltas doesn't trigger Owl re-renders — only the
     *  derived scale/tx/ty in `state` do. */
    private _gesture: "idle" | "swipe" | "pinch" | "pan" = "idle";
    private _swipeStartX = 0;
    private _pinchStartDist = 0;
    private _pinchStartScale = 1;
    private _panStartX = 0;
    private _panStartY = 0;
    private _panStartTx = 0;
    private _panStartTy = 0;
    private _lastTapAt = 0;
    private static readonly MAX_SCALE = 4;
    private static readonly DOUBLE_TAP_MS = 300;
    private static readonly DOUBLE_TAP_PX = 30;
    private static readonly SWIPE_THRESHOLD_PX = 50;

    setup() {
        this.state = useState<State>({
            images: [],
            loading: true,
            fullscreenIdx: -1,
            error: "",
            scale: 1,
            tx: 0,
            ty: 0,
        });
        this._gallery = new GalleryService(this.databaseService);

        onMounted(async () => {
            try {
                this.state.images = await this._gallery.getAllImages();
            } catch (e: unknown) {
                this.state.error = "Erreur : "
                    + (e instanceof Error ? e.message : String(e));
            } finally {
                this.state.loading = false;
            }
            // Hand the deck the current image list so it can flip into
            // remote mode and paint thumbnails. We pass the WebView URL
            // (Capacitor.convertFileSrc) rather than the raw file://
            // path so the controller's <img> can load it without
            // tainting the canvas. Re-emitted on every successful load
            // so the deck doesn't get stuck on a stale list if the
            // user re-navigates here after adding photos elsewhere.
            this._emitDeckPageActive(true);
            this.eventBus.addEventListener(
                Events.STREAMDECK_GALLERY_OPEN, this._onDeckOpen,
            );
            this.eventBus.addEventListener(
                Events.STREAMDECK_GALLERY_BACK, this._onDeckBack,
            );
        });

        onWillDestroy(() => {
            this._emitDeckPageActive(false);
            this.eventBus.removeEventListener(
                Events.STREAMDECK_GALLERY_OPEN, this._onDeckOpen,
            );
            this.eventBus.removeEventListener(
                Events.STREAMDECK_GALLERY_BACK, this._onDeckBack,
            );
        });
    }

    private _emitDeckPageActive(active: boolean) {
        const images = active
            ? this.state.images.map((im, i) => ({
                  url: this.webPath(im.path),
                  index: i,
              }))
            : [];
        this.eventBus.trigger(Events.STREAMDECK_GALLERY_PAGE_ACTIVE, {
            active, images,
        });
    }

    private _onDeckOpen = (e: any) => {
        const idx = e?.detail?.index;
        if (typeof idx === "number") this.openFullscreen(idx);
    };

    private _onDeckBack = () => {
        // Mobile-side mirror of the deck's back key: in fullscreen we
        // first close the viewer (one tap = back to mosaic), and only
        // route away from the page on a second press. Matches the
        // expectations of someone using the deck as a remote.
        if (this.state.fullscreenIdx !== -1) {
            this.closeFullscreen();
            return;
        }
        this.navigate("/options");
    };

    /** Convert a stored entry path to a WebView-loadable URL. */
    webPath(p: string): string {
        if (!p) return "";
        if (p.startsWith("data:") || p.startsWith("http")) return p;
        return Capacitor.convertFileSrc(p);
    }

    openFullscreen(idx: number) {
        if (idx < 0 || idx >= this.state.images.length) return;
        this.state.fullscreenIdx = idx;
        this._resetZoom();
    }

    closeFullscreen() {
        this.state.fullscreenIdx = -1;
        this._resetZoom();
    }

    prev() {
        if (this.state.fullscreenIdx > 0) {
            this.state.fullscreenIdx--;
            this._resetZoom();
        }
    }

    next() {
        if (this.state.fullscreenIdx < this.state.images.length - 1) {
            this.state.fullscreenIdx++;
            this._resetZoom();
        }
    }

    /** Inline transform for the fullscreen <img>. Translate is applied
     *  *before* scale so the pan deltas stay in screen pixels — easier
     *  to clamp later if we want bounded panning. */
    get imageTransform(): string {
        return `transform: translate(${this.state.tx}px, ${this.state.ty}px) `
             + `scale(${this.state.scale});`
             + ` transition: transform 0ms;`;
    }

    onTouchStart(ev: TouchEvent) {
        if (ev.touches.length >= 2) {
            // Two fingers down — pinch. Cancels any pan/swipe in flight
            // so the user can switch gestures mid-stream without
            // lifting all fingers.
            this._gesture = "pinch";
            this._pinchStartDist = this._fingerDistance(ev);
            this._pinchStartScale = this.state.scale;
            return;
        }
        const t = ev.touches[0];
        if (!t) return;
        // Double-tap → toggle 1× ↔ 2×. Detected on the *second*
        // touchstart whose timestamp + position fall inside the
        // double-tap window. We bail early so the swipe machine
        // doesn't also fire.
        const now = Date.now();
        if (now - this._lastTapAt < OptionsGalleryComponent.DOUBLE_TAP_MS) {
            this._toggleZoom();
            this._lastTapAt = 0;
            this._gesture = "idle";
            return;
        }
        this._lastTapAt = now;
        if (this.state.scale > 1) {
            // Already zoomed: one-finger drag pans the image.
            this._gesture = "pan";
            this._panStartX = t.clientX;
            this._panStartY = t.clientY;
            this._panStartTx = this.state.tx;
            this._panStartTy = this.state.ty;
        } else {
            // Not zoomed: one-finger swipe steps prev/next.
            this._gesture = "swipe";
            this._swipeStartX = t.clientX;
        }
    }

    onTouchMove(ev: TouchEvent) {
        if (this._gesture === "pinch" && ev.touches.length >= 2) {
            const dist = this._fingerDistance(ev);
            if (this._pinchStartDist <= 0) return;
            const ratio = dist / this._pinchStartDist;
            const next = this._pinchStartScale * ratio;
            this.state.scale = Math.max(
                1, Math.min(OptionsGalleryComponent.MAX_SCALE, next),
            );
            // Keep the picture centred when pinching down to 1× —
            // otherwise the residual pan from a previous zoom would
            // leave the image stuck off-screen.
            if (this.state.scale === 1) {
                this.state.tx = 0;
                this.state.ty = 0;
            }
            return;
        }
        if (this._gesture === "pan" && ev.touches.length === 1) {
            const t = ev.touches[0];
            this.state.tx = this._panStartTx + (t.clientX - this._panStartX);
            this.state.ty = this._panStartTy + (t.clientY - this._panStartY);
        }
    }

    onTouchEnd(ev: TouchEvent) {
        if (this._gesture === "pinch") {
            // Snap back to 1× if the user pinched well below it — small
            // numerical drift from float math (e.g. 0.998) shouldn't
            // leave the viewer in a "barely zoomed" weird state.
            if (this.state.scale < 1.05) {
                this.state.scale = 1;
                this.state.tx = 0;
                this.state.ty = 0;
            }
            this._gesture = "idle";
            return;
        }
        if (this._gesture === "swipe") {
            const dx = (ev.changedTouches[0]?.clientX ?? 0) - this._swipeStartX;
            this._gesture = "idle";
            if (Math.abs(dx) < OptionsGalleryComponent.SWIPE_THRESHOLD_PX) return;
            if (dx < 0) this.next(); else this.prev();
            return;
        }
        this._gesture = "idle";
    }

    private _fingerDistance(ev: TouchEvent): number {
        const a = ev.touches[0];
        const b = ev.touches[1];
        if (!a || !b) return 0;
        return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    }

    private _toggleZoom() {
        if (this.state.scale > 1) {
            this._resetZoom();
        } else {
            this.state.scale = 2;
        }
    }

    private _resetZoom() {
        this.state.scale = 1;
        this.state.tx = 0;
        this.state.ty = 0;
    }

}
