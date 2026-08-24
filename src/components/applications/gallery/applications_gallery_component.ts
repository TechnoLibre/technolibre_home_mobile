import { onMounted, onWillDestroy, useRef, useState, xml } from "@odoo/owl";
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
    /** Chrome-on means the close / prev / next buttons and the caption
     *  strip are visible. A clean tap on the image toggles it so the
     *  user can see the picture without the controls obstructing it. */
    chrome:        boolean;
    /** When true, the viewer auto-rotates landscape photos in a
     *  portrait viewport (and vice versa) so the image fills the
     *  screen without being letterboxed. User-toggleable, persisted
     *  in localStorage. */
    autoRotate:    boolean;
    /** Rotation applied to the current image (0 or 90 degrees).
     *  Recomputed every time a new image loads or the toggle flips. */
    imageRotation: number;
    /** Pixel size of the viewer area minus the caption strip — used
     *  to size the rotated image's box so its rotated bounding box
     *  fills the available area. Updated on each image load. */
    viewerW:       number;
    viewerH:       number;
}

export class ApplicationsGalleryComponent extends EnhancedComponent {
    static template = xml`
        <div id="applications-gallery-component">
            <HeadingComponent title="t('heading.gallery')" backUrl="'/applications'"/>

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
                 t-att-aria-label="t('aria.image_grid')">
                <button t-foreach="state.images" t-as="img" t-key="img.entryId"
                        class="gallery__tile"
                        t-att-aria-label="t('aria.open_image', { title: img.noteTitle || t('aria.untitled_note') })"
                        t-on-click="() => this.openFullscreen(img_index)">
                    <img t-att-src="webPath(img.path)" alt=""/>
                </button>
            </div>

            <!-- ── Fullscreen carousel ─────────────────────────────── -->
            <div t-else=""
                 class="gallery__viewer"
                 t-ref="viewer"
                 t-on-touchstart="onTouchStart"
                 t-on-touchmove="onTouchMove"
                 t-on-touchend="onTouchEnd"
                 t-on-touchcancel="onTouchEnd"
                 t-att-aria-label="t('aria.fullscreen_viewer')">
                <button t-if="state.chrome"
                        class="gallery__viewer__btn gallery__viewer__btn--rotate"
                        t-att-class="{ 'gallery__viewer__btn--rotate-on': state.autoRotate }"
                        t-att-aria-label="state.autoRotate ? t('aria.autorotate_on') : t('aria.autorotate_off')"
                        t-on-click="toggleAutoRotate">⤢</button>
                <button t-if="state.chrome"
                        class="gallery__viewer__btn gallery__viewer__btn--close"
                        t-att-aria-label="t('aria.back_to_grid')"
                        t-on-click="closeFullscreen">×</button>
                <button t-if="state.chrome"
                        class="gallery__viewer__btn gallery__viewer__btn--prev"
                        t-att-disabled="state.fullscreenIdx === 0 ? 'true' : null"
                        t-att-aria-label="t('aria.previous_image')"
                        t-on-click="prev">‹</button>
                <button t-if="state.chrome"
                        class="gallery__viewer__btn gallery__viewer__btn--next"
                        t-att-disabled="state.fullscreenIdx >= state.images.length - 1 ? 'true' : null"
                        t-att-aria-label="t('aria.next_image')"
                        t-on-click="next">›</button>
                <img class="gallery__viewer__img"
                     t-att-src="webPath(state.images[state.fullscreenIdx].path)"
                     t-att-alt="state.images[state.fullscreenIdx].noteTitle"
                     t-att-style="imageTransform"
                     t-on-load="onImageLoad"/>
                <div t-if="state.chrome" class="gallery__viewer__caption">
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
    /** Ref to the .gallery__viewer element so we can read its
     *  client dimensions when computing rotated-image box size. */
    private _viewerRef = useRef("viewer");
    /** Storage key for the autoRotate preference. */
    private static readonly AUTO_ROTATE_KEY = "gallery.autoRotate";
    /** Caption strip height in px (4rem ≈ 64px on default root size). */
    private static readonly CAPTION_PX = 64;
    /** Gesture-machine state. Refs (not reactive) so a 60 fps stream of
     *  touchmove deltas doesn't trigger Owl re-renders — only the
     *  derived scale/tx/ty in `state` do. */
    private _gesture: "idle" | "swipe" | "pinch" | "pan" = "idle";
    private _swipeStartX = 0;
    private _swipeStartY = 0;
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
    /** A touch that ends with less than this much total movement is
     *  treated as a clean tap. Above this, it's a swipe / drag. */
    private static readonly TAP_MAX_DRIFT_PX = 10;

    setup() {
        // autoRotate defaults to true; localStorage may override it
        // with a previous opt-out. Reading once at setup is enough —
        // the toggle handler is the only writer in this component.
        let autoRotate = true;
        try {
            const stored = localStorage.getItem(
                ApplicationsGalleryComponent.AUTO_ROTATE_KEY,
            );
            if (stored === "false") autoRotate = false;
        } catch { /* private mode — ignore */ }
        this.state = useState<State>({
            images: [],
            loading: true,
            fullscreenIdx: -1,
            error: "",
            scale: 1,
            tx: 0,
            ty: 0,
            chrome: true,
            autoRotate,
            imageRotation: 0,
            viewerW: 0,
            viewerH: 0,
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
        this.navigate("/applications");
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
        // Each new viewing session starts with the chrome visible —
        // the user opted in to fullscreen by tapping a tile, they
        // need the close button at hand. Within a session, prev/next
        // preserves whatever chrome state the user picked.
        this.state.chrome = true;
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

    /** Inline style for the fullscreen <img>. Drives both the box
     *  dimensions (so a rotated image's bounding box matches the
     *  viewer area, no overflow) and the transform stack (translate
     *  first → rotation → scale, applied right-to-left so pan stays
     *  in screen pixels and zoom centres on the rotated content). */
    get imageTransform(): string {
        const rot = this.state.imageRotation;
        const tf = `translate(${this.state.tx}px, ${this.state.ty}px) `
                 + `rotate(${rot}deg) `
                 + `scale(${this.state.scale})`;
        const captionPx = ApplicationsGalleryComponent.CAPTION_PX;
        let boxW: string;
        let boxH: string;
        if (rot === 0) {
            boxW = `100%`;
            boxH = `calc(100% - ${captionPx}px)`;
        } else {
            // Swap so the rotated bounding box matches the viewer
            // area. We need pixel values here because percentages
            // refer to parent width/height respectively — there's no
            // way to say "width = parent's height" in pure CSS.
            // Falls back to 100%/calc on first paint before the
            // first measurement lands.
            const w = this.state.viewerH || 0;
            const h = this.state.viewerW || 0;
            boxW = w > 0 ? `${w - captionPx}px` : `calc(100% - ${captionPx}px)`;
            boxH = h > 0 ? `${h}px` : `100%`;
        }
        return `width: ${boxW}; height: ${boxH}; `
             + `transform: ${tf}; `
             + `transition: transform 0ms;`;
    }

    /** Fired by the <img> on every successful load (each navigation
     *  re-mounts the underlying network/file fetch). Measures the
     *  viewer area and recomputes whether this particular image
     *  should be auto-rotated to fill the screen. */
    onImageLoad(ev: Event): void {
        const img = ev.target as HTMLImageElement;
        this._measureViewer();
        this._updateRotationFor(img);
    }

    toggleAutoRotate(): void {
        this.state.autoRotate = !this.state.autoRotate;
        try {
            localStorage.setItem(
                ApplicationsGalleryComponent.AUTO_ROTATE_KEY,
                this.state.autoRotate ? "true" : "false",
            );
        } catch { /* ignore */ }
        // Re-evaluate the current image with the new preference. We
        // can't read natural dimensions from the DOM cheaply, so go
        // through the actual <img> element via the viewer ref.
        const img = this._viewerRef.el?.querySelector(
            "img.gallery__viewer__img",
        ) as HTMLImageElement | null;
        if (img) {
            this._measureViewer();
            this._updateRotationFor(img);
        }
    }

    private _measureViewer(): void {
        const el = this._viewerRef.el as HTMLElement | null;
        if (!el) return;
        this.state.viewerW = el.clientWidth;
        this.state.viewerH = el.clientHeight;
    }

    private _updateRotationFor(img: HTMLImageElement): void {
        if (!this.state.autoRotate) {
            this.state.imageRotation = 0;
            return;
        }
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        if (!iw || !ih) {
            this.state.imageRotation = 0;
            return;
        }
        const vw = this.state.viewerW;
        const vh = this.state.viewerH;
        // Both areas have an orientation. Mismatch = rotate 90 to
        // align them; equal = no rotation. Square images (ratio ≈ 1)
        // are left unrotated since there is nothing to gain.
        const imgLandscape = iw > ih;
        const viewerLandscape = vw > vh;
        const square = Math.abs(iw - ih) / Math.max(iw, ih) < 0.05;
        if (square || imgLandscape === viewerLandscape) {
            this.state.imageRotation = 0;
        } else {
            this.state.imageRotation = 90;
        }
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
        if (now - this._lastTapAt < ApplicationsGalleryComponent.DOUBLE_TAP_MS) {
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
            // Not zoomed: one-finger gesture is either a swipe (prev /
            // next) or a tap-on-image (toggle chrome). Track both axes
            // so onTouchEnd can tell them apart with a movement
            // threshold; horizontal-only tracking would let a small
            // vertical drift register as a tap.
            this._gesture = "swipe";
            this._swipeStartX = t.clientX;
            this._swipeStartY = t.clientY;
        }
    }

    onTouchMove(ev: TouchEvent) {
        if (this._gesture === "pinch" && ev.touches.length >= 2) {
            const dist = this._fingerDistance(ev);
            if (this._pinchStartDist <= 0) return;
            const ratio = dist / this._pinchStartDist;
            const next = this._pinchStartScale * ratio;
            this.state.scale = Math.max(
                1, Math.min(ApplicationsGalleryComponent.MAX_SCALE, next),
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
            const t = ev.changedTouches[0];
            const dx = (t?.clientX ?? 0) - this._swipeStartX;
            const dy = (t?.clientY ?? 0) - this._swipeStartY;
            const drift = Math.hypot(dx, dy);
            this._gesture = "idle";
            if (drift < ApplicationsGalleryComponent.TAP_MAX_DRIFT_PX) {
                // Clean tap. Only toggle chrome if the touch landed on
                // the image itself — taps that hit the close / prev /
                // next buttons or the caption already do their own
                // thing and the user did not ask for a chrome toggle.
                const tgt = ev.target as HTMLElement | null;
                if (tgt?.tagName === "IMG") {
                    this.state.chrome = !this.state.chrome;
                }
                return;
            }
            if (Math.abs(dx) < ApplicationsGalleryComponent.SWIPE_THRESHOLD_PX) return;
            // Reject diagonal drags as swipes — preserves the tap-vs-
            // swipe distinction for users who scroll a bit vertically.
            if (Math.abs(dy) > Math.abs(dx)) return;
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
        // Each new image starts unrotated; onImageLoad recomputes
        // immediately after the natural size lands. Clearing here
        // (instead of leaving the previous image's rotation) avoids
        // a brief flash where a portrait shot inherits a rotation
        // from a landscape predecessor.
        this.state.imageRotation = 0;
    }

}
