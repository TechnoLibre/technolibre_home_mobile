import {useState, xml} from "@odoo/owl";

import {EnhancedComponent} from "../../js/enhancedComponent";
import {Events} from "../../constants/events";

// @ts-ignore
import CompanyLogo from "../../assets/company_logo.png";

const ENV = {
    // @ts-ignore
    TITLE: import.meta.env.VITE_TITLE ?? "TITLE",
    // @ts-ignore
    LABEL_NOTE: import.meta.env.VITE_LABEL_NOTE ?? "Note",
    // @ts-ignore
    DEBUG_DEV: import.meta.env.VITE_DEBUG_DEV === "true",
};

const STARTUP_TIME = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});

export class HomeComponent extends EnhancedComponent {
    static template = xml`
    <div id="home-component">
      <div id="centered-content">
        <img id="logo" src="${CompanyLogo}" alt="Logo ERPLibre"
             t-att-class="{'logo--spinning': state.spinning}"
             t-on-click="onLogoClick"
             t-on-animationend="onSpinEnd" />
        <h3 id="title" t-esc="state.title" />
        <section id="buttons">
          <button id="notes" class="buttons-primary" t-on-click.stop.prevent="onNotesClick">${ENV.LABEL_NOTE}s</button>
          <button id="notes-new" class="buttons-primary" t-on-click.stop.prevent="onNoteNewClick">Ajout ${ENV.LABEL_NOTE}s</button>
        </section>
      </div>
      <p id="startup-time">Ouvert à ${STARTUP_TIME}</p>
    </div>
  `;

    setup() {
        this.state = useState({title: ENV.TITLE, isDev: ENV.DEBUG_DEV, spinning: false});
    }

    onLogoClick() {
        this.state.spinning = true;
    }

    onSpinEnd() {
        this.state.spinning = false;
    }

    onNotesClick() {
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {url: "/notes"});
    }

    onNoteNewClick() {
        const newId = this.noteService.getNewId();
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {url: `/note/${newId}`});
    }
}
