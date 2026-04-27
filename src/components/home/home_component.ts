import {onMounted, useState, xml} from "@odoo/owl";

import {EnhancedComponent} from "../../js/enhancedComponent";
import {Events} from "../../constants/events";
import {Note} from "../../models/note";
import {Tag} from "../../models/tag";

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

interface HomeState {
    title: string;
    spinning: boolean;
    noteCount: number;
    appCount: number;
    serverCount: number;
    quickNotes: Note[];
    rootTags: Tag[];
    loaded: boolean;
}

export class HomeComponent extends EnhancedComponent {
    state!: HomeState;

    // Module-level constants exposed to the static template so the xml`...`
    // literal stays interpolation-free and AOT-precompilable.
    companyLogo = CompanyLogo;
    labelNote = ENV.LABEL_NOTE;
    startupTime = STARTUP_TIME;

    static template = xml`
    <div id="home-component">
      <div id="home-header">
        <img id="logo" t-att-src="companyLogo" alt="Logo ERPLibre"
             role="button"
             tabindex="0"
             aria-label="Faire tourner le logo"
             t-att-class="{'logo--spinning': state.spinning}"
             t-on-click="onLogoClick"
             t-on-keydown="(ev) => (ev.key === 'Enter' || ev.key === ' ') ? onLogoClick() : null"
             t-on-animationend="onSpinEnd" />
        <h1 id="title" t-esc="state.title" />
      </div>

      <div id="home-stats" t-if="state.loaded" aria-label="Statistiques">
        <span class="home-stats__item">
          <span class="home-stats__value" t-esc="state.noteCount" />
          <span class="home-stats__label"> note<t t-if="state.noteCount !== 1">s</t></span>
        </span>
        <span class="home-stats__sep" aria-hidden="true">·</span>
        <span class="home-stats__item">
          <span class="home-stats__value" t-esc="state.appCount" />
          <span class="home-stats__label"> app<t t-if="state.appCount !== 1">s</t> Odoo</span>
        </span>
        <span class="home-stats__sep" aria-hidden="true">·</span>
        <span class="home-stats__item">
          <span class="home-stats__value" t-esc="state.serverCount" />
          <span class="home-stats__label"> serveur<t t-if="state.serverCount !== 1">s</t></span>
        </span>
        <t t-set="activeCount" t-value="deploymentService.deployments.length" />
        <t t-if="activeCount > 0">
          <span class="home-stats__sep" aria-hidden="true">·</span>
          <span class="home-stats__item home-stats__item--deploy">
            <span class="home-stats__deploy-dot" aria-hidden="true"/>
            <span class="home-stats__value" t-esc="activeCount" />
            <span class="home-stats__label"> déploiement<t t-if="activeCount !== 1">s</t></span>
          </span>
        </t>
      </div>

      <div id="home-actions" role="list">
        <button class="home-action-card" role="listitem" t-on-click="onNotesClick"
                t-att-aria-label="state.noteCount + ' note' + (state.noteCount !== 1 ? 's' : '') + ' — ouvrir la liste'">
          <span class="home-action-card__icon" aria-hidden="true">📝</span>
          <span class="home-action-card__label"><t t-esc="labelNote"/>s</span>
          <span t-if="state.noteCount > 0" class="home-action-card__badge"
                t-esc="state.noteCount" aria-hidden="true"/>
        </button>
        <button class="home-action-card home-action-card--accent" role="listitem" t-on-click="onNoteNewClick"
                aria-label="Créer une nouvelle note">
          <span class="home-action-card__icon" aria-hidden="true">✏️</span>
          <span class="home-action-card__label">Nouvelle</span>
        </button>
        <button class="home-action-card" role="listitem" t-on-click="onServersClick"
                t-att-aria-label="state.serverCount + ' serveur' + (state.serverCount !== 1 ? 's' : '') + ' — gérer les serveurs'">
          <span class="home-action-card__icon" aria-hidden="true">🖥️</span>
          <span class="home-action-card__label">Serveurs</span>
          <span t-if="state.serverCount > 0" class="home-action-card__badge"
                t-esc="state.serverCount" aria-hidden="true"/>
        </button>
        <button class="home-action-card" role="listitem" t-on-click="onApplicationsClick"
                t-att-aria-label="state.appCount + ' application' + (state.appCount !== 1 ? 's' : '') + ' Odoo — gérer les applications'">
          <span class="home-action-card__icon" aria-hidden="true">🔗</span>
          <span class="home-action-card__label">Odoo</span>
          <span t-if="state.appCount > 0" class="home-action-card__badge"
                t-esc="state.appCount" aria-hidden="true"/>
        </button>
      </div>

      <div id="home-quick-notes" t-if="state.loaded and state.quickNotes.length > 0">
        <p class="home-quick-notes__heading" aria-hidden="true">Accès rapide</p>
        <ul class="home-quick-notes__list" aria-label="Accès rapide aux notes">
          <li t-foreach="state.quickNotes" t-as="note" t-key="note.id">
            <button class="home-quick-note"
                    t-att-class="{
                      'home-quick-note--priority-1': note.priority === 1,
                      'home-quick-note--priority-2': note.priority === 2,
                      'home-quick-note--priority-3': note.priority === 3,
                      'home-quick-note--priority-4': note.priority === 4,
                    }"
                    t-att-aria-label="'Ouvrir : ' + (note.title || '(Sans titre)')"
                    t-on-click="() => this.onNoteClick(note.id)">
              <span t-if="note.pinned" class="home-quick-note__pin" aria-label="Épinglée">📌</span>
              <span class="home-quick-note__title" t-esc="note.title || '(Sans titre)'" />
              <span t-if="note.date" class="home-quick-note__date" t-esc="formatNoteDate(note.date)" />
              <span t-if="note.done" class="home-quick-note__done" aria-label="Terminée">✓</span>
            </button>
          </li>
        </ul>
      </div>

      <div id="home-tags" t-if="state.loaded and state.rootTags.length > 0">
        <p class="home-tags__heading" aria-hidden="true">Tags</p>
        <ul class="home-tags__list" aria-label="Filtrer par tag">
          <li t-foreach="state.rootTags" t-as="tag" t-key="tag.id">
            <button
              class="home-tag-chip"
              t-att-style="'background-color:' + tag.color"
              t-att-aria-label="'Tag : ' + tag.name"
              t-on-click="() => this.onTagClick(tag.id)"
            >
              <t t-esc="tag.name" />
            </button>
          </li>
        </ul>
      </div>

      <p id="startup-time" aria-hidden="true">Ouvert à <t t-esc="startupTime"/></p>
    </div>
  `;

    setup() {
        this.state = useState<HomeState>({
            title: ENV.TITLE,
            spinning: false,
            noteCount: 0,
            appCount: 0,
            serverCount: 0,
            quickNotes: [],
            rootTags: [],
            loaded: false,
        });
        onMounted(() => this.loadStats());
    }

    async loadStats() {
        const [notes, apps, servers, rootTags] = await Promise.all([
            this.noteService.getNotes(),
            this.appService.getApps(),
            this.serverService.getServers(),
            this.tagService.getRootTags(),
        ]);
        const active = notes.filter((n) => !n.archived);
        // Priority 1 (Urgent + Important) first, then most recently created
        const critical = active.filter((n) => n.priority === 1);
        const rest = active.filter((n) => n.priority !== 1).reverse();
        const quick = [...critical, ...rest].slice(0, 4);
        this.state.noteCount = active.length;
        this.state.appCount = apps.length;
        this.state.serverCount = servers.length;
        this.state.quickNotes = quick;
        this.state.rootTags = rootTags;
        this.state.loaded = true;
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

    onNoteClick(id: string) {
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {url: `/note/${id}`});
    }

    onServersClick() {
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {url: "/applications"});
    }

    onApplicationsClick() {
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {url: "/applications"});
    }

    onTagClick(tagId: string) {
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {url: `/tags/${tagId}`});
    }

    formatNoteDate(date: string): string {
        return new Date(date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    }
}
