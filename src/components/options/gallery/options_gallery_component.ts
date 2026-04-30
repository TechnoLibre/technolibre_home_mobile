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
                 t-on-touchend="onTouchEnd"
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
                     t-att-alt="state.images[state.fullscreenIdx].noteTitle"/>
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
    private _touchStartX = 0;

    setup() {
        this.state = useState<State>({
            images: [],
            loading: true,
            fullscreenIdx: -1,
            error: "",
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
    }

    closeFullscreen() {
        this.state.fullscreenIdx = -1;
    }

    prev() {
        if (this.state.fullscreenIdx > 0) {
            this.state.fullscreenIdx--;
        }
    }

    next() {
        if (this.state.fullscreenIdx < this.state.images.length - 1) {
            this.state.fullscreenIdx++;
        }
    }

    onTouchStart(ev: TouchEvent) {
        this._touchStartX = ev.touches[0]?.clientX ?? 0;
    }

    onTouchEnd(ev: TouchEvent) {
        const dx = (ev.changedTouches[0]?.clientX ?? 0) - this._touchStartX;
        if (Math.abs(dx) < 50) return;
        if (dx < 0) this.next(); else this.prev();
    }

}
