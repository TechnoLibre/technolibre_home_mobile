import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import AddDateIcon from "../../../assets/icon/date_edit.svg";
import AddPhotoIcon from "../../../assets/icon/photo.svg";
import AddVideoIcon from "../../../assets/icon/video_add.svg";
import AddImageIcon from "../../../assets/icon/image.svg";
import AudioIcon from "../../../assets/icon/audio.svg";
import GlobeLocationIcon from "../../../assets/icon/globe_location.svg";
import TextIcon from "../../../assets/icon/text-selection-svgrepo-com.svg";

export class NoteBottomControlsComponent extends EnhancedComponent {
    // Module-level constants exposed to the static template so the xml`...`
    // literal stays interpolation-free and AOT-precompilable.
    globeLocationIcon = GlobeLocationIcon;
    addPhotoIcon = AddPhotoIcon;
    addImageIcon = AddImageIcon;
    addVideoIcon = AddVideoIcon;
    audioIcon = AudioIcon;
    textIcon = TextIcon;
    addDateIcon = AddDateIcon;

    state!: { expanded: boolean };

    setup() {
        // Collapsed by default — only Image and Text are reachable in
        // one tap. Pressing the … toggle expands to all seven entry
        // types. Pressing it again collapses back.
        this.state = useState({ expanded: false });
    }

    onToggleMore() {
        this.state.expanded = !this.state.expanded;
    }

    static template = xml`
<div id="note__bottom-controls__wrapper">
    <section id="note__bottom-controls"
             t-att-class="{ 'note__bottom-controls--expanded': state.expanded }">
        <a t-if="state.expanded"
           id="note__control__location"
           class="note__control"
           href="#"
           role="button"
           aria-label="Ajouter un lieu"
           t-on-click.stop.prevent="props.addLocation"
        >
            <img t-att-src="globeLocationIcon" alt="" aria-hidden="true"/>
            <span>Lieu</span>
        </a>
        <a t-if="state.expanded"
           id="note__control__photo"
           class="note__control"
           href="#"
           role="button"
           aria-label="Ajouter une photo"
           t-on-click.stop.prevent="props.addPhoto"
        >
            <img t-att-src="addPhotoIcon" alt="" aria-hidden="true"/>
            <span>Photo</span>
        </a>
        <a id="note__control__image"
           class="note__control"
           href="#"
           role="button"
           aria-label="Ajouter une image depuis la galerie"
           t-on-click.stop.prevent="props.addImage"
        >
            <img t-att-src="addImageIcon" alt="" aria-hidden="true"/>
            <span>Image</span>
        </a>
        <a t-if="state.expanded"
           id="note__control__video"
           class="note__control"
           href="#"
           role="button"
           aria-label="Ajouter une vidéo"
           t-on-click.stop.prevent="props.addVideo"
        >
            <img t-att-src="addVideoIcon" alt="" aria-hidden="true"/>
            <span>Vidéo</span>
        </a>
        <a t-if="state.expanded"
           id="note__control__audio"
           class="note__control"
           href="#"
           role="button"
           aria-label="Ajouter un audio"
           t-on-click.stop.prevent="props.addAudio"
        >
            <img t-att-src="audioIcon" alt="" aria-hidden="true"/>
            <span>Audio</span>
        </a>
        <a id="note__control__text"
           class="note__control"
           href="#"
           role="button"
           aria-label="Ajouter du texte"
           t-on-click.stop.prevent="props.addText"
        >
            <img t-att-src="textIcon" alt="" aria-hidden="true"/>
            <span>Texte</span>
        </a>
        <a t-if="state.expanded"
           id="note__control__date"
           class="note__control"
           href="#"
           role="button"
           aria-label="Ajouter une date"
           t-on-click.stop.prevent="props.addDateEntry"
        >
            <img t-att-src="addDateIcon" alt="" aria-hidden="true"/>
            <span>Date</span>
        </a>
        <button type="button"
                id="note__control__more"
                class="note__control note__control--more"
                t-att-aria-expanded="state.expanded ? 'true' : 'false'"
                aria-controls="note__bottom-controls"
                t-att-aria-label="state.expanded ? 'Réduire les boutons' : 'Afficher tous les boutons'"
                t-on-click.stop.prevent="onToggleMore"
        >
            <span class="note__control__more__dots"
                  t-esc="state.expanded ? '×' : '⋯'"/>
            <span t-esc="state.expanded ? 'Réduire' : 'Plus'"/>
        </button>
    </section>
</div>
    `;
}
