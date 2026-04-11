import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import type { SyncCredentials } from "../../../services/syncService";

import DeleteIcon from "../../../assets/icon/delete.svg";
import EditIcon from "../../../assets/icon/edit.svg";
import OpenIcon from "../../../assets/icon/open.svg";
import UserIcon from "../../../assets/icon/user.svg";

interface ModelData {
	loading: boolean;
	count: number;
	fields: Array<{ name: string; fieldDescription: string; ttype: string }>;
}

export class ApplicationsItemComponent extends EnhancedComponent {
	static template = xml`
    <li class="app-list__item">
      <div class="app-list__item__data">
        <p class="app-list__item__url"><t t-esc="props.app.url"></t></p>
      </div>
      <div class="app-list__item__user">
        <img src="${UserIcon}" />
        <p class="app-list__item__username"><t t-esc="props.app.username"></t></p>
      </div>
      <div class="app-list__item__actions">
        <button
          type="button"
          class="app-list__item__action app-list__item__delete"
          t-on-click.stop="() => this.props.deleteApp(state.appID)"
        >
          <img src="${DeleteIcon}" />
        </button>
        <button
          type="button"
          class="app-list__item__action app-list__item__info"
          t-on-click.stop="onInfoClick"
          title="Informations Odoo"
        >ℹ</button>
        <button
          type="button"
          class="app-list__item__action app-list__item__edit"
          t-on-click.stop="() => this.props.editApp(state.appID)"
        >
          <img src="${EditIcon}" />
        </button>
        <button
          type="button"
          class="app-list__item__action app-list__item__open"
          t-on-click.stop="() => this.props.openApp(state.appID)"
        >
          <img src="${OpenIcon}" />
        </button>
      </div>
    </li>

    <!-- Odoo info dialog (fixed overlay rendered outside the list item flow) -->
    <div t-if="state.dialog.visible" class="app-info-overlay" t-on-click.stop.prevent="closeDialog">
      <div class="app-info-dialog" t-on-click.stop="">
        <div class="app-info-dialog__header">
          <span class="app-info-dialog__title" t-esc="props.app.url" />
          <button type="button" class="app-info-dialog__close" t-on-click.stop.prevent="closeDialog">✕</button>
        </div>

        <div t-if="state.dialog.loading" class="app-info-dialog__status">Chargement…</div>
        <div t-elif="state.dialog.error" class="app-info-dialog__status app-info-dialog__status--error">
          <pre class="app-info-dialog__error-text" t-esc="state.dialog.error" />
          <div class="app-info-dialog__error-actions">
            <button type="button" class="app-info-dialog__error-btn" t-on-click.stop="() => this.copyError()">
              📋 Copier
            </button>
            <button type="button" class="app-info-dialog__error-btn app-info-dialog__error-btn--issue" t-on-click.stop="() => this.openIssue()">
              🐛 Créer un ticket
            </button>
          </div>
        </div>
        <div t-else="" class="app-info-dialog__body">
          <div class="app-info-dialog__meta">
            <span class="app-info-dialog__version" t-esc="state.dialog.version" />
            <span class="app-info-dialog__model-total"><t t-esc="state.dialog.models.length" /> modèles</span>
          </div>
          <input
            type="text"
            class="app-info-dialog__filter"
            placeholder="Filtrer les modèles…"
            t-model="state.dialog.filter"
          />
          <ul class="app-info-dialog__model-list">
            <t t-foreach="filteredModels" t-as="m" t-key="m.model">
              <li class="app-info-dialog__model-item">
                <button
                  type="button"
                  class="app-info-dialog__model-btn"
                  t-on-click.stop="() => this.toggleModel(m.model)"
                >
                  <span class="app-info-dialog__model-technical" t-esc="m.model" />
                  <span class="app-info-dialog__model-label" t-esc="m.name" />
                  <span t-if="state.dialog.modelData[m.model] and state.dialog.modelData[m.model].count >= 0"
                        class="app-info-dialog__model-count"
                        t-esc="state.dialog.modelData[m.model].count + ' enreg.'" />
                  <span class="app-info-dialog__model-chevron">
                    <t t-esc="state.dialog.expanded[m.model] ? '▲' : '▼'" />
                  </span>
                </button>
                <div t-if="state.dialog.expanded[m.model]" class="app-info-dialog__fields">
                  <div t-if="!state.dialog.modelData[m.model] or state.dialog.modelData[m.model].loading"
                       class="app-info-dialog__field-loading">Chargement des champs…</div>
                  <p t-elif="state.dialog.modelData[m.model].fields.length === 0"
                     class="app-info-dialog__field-loading">Aucun champ trouvé.</p>
                  <ul t-else="" class="app-info-dialog__field-list">
                    <li t-foreach="state.dialog.modelData[m.model].fields"
                        t-as="f"
                        t-key="f.name"
                        class="app-info-dialog__field-row">
                      <div class="app-info-dialog__field-header">
                        <span class="app-info-dialog__field-name" t-esc="f.name" />
                        <span class="app-info-dialog__field-type" t-esc="f.ttype" />
                      </div>
                      <span class="app-info-dialog__field-desc" t-esc="f.fieldDescription" />
                    </li>
                  </ul>
                </div>
              </li>
            </t>
          </ul>
        </div>
      </div>
    </div>
  `;

	setup() {
		this.state = useState({
			appID: { url: this.props.app.url, username: this.props.app.username },
			dialog: {
				visible: false,
				loading: false,
				error: "",
				version: "",
				filter: "",
				models: [] as Array<{ name: string; model: string }>,
				expanded: {} as Record<string, boolean>,
				modelData: {} as Record<string, ModelData>,
			},
		});
	}

	private get creds(): SyncCredentials {
		const app = this.props.app;
		return {
			odooUrl: app.url,
			username: app.username,
			password: app.password,
			database: app.database || "",
		};
	}

	get filteredModels(): Array<{ name: string; model: string }> {
		const f = (this.state.dialog.filter as string).toLowerCase().trim();
		if (!f) return this.state.dialog.models;
		return (this.state.dialog.models as Array<{ name: string; model: string }>).filter(
			(m) => m.model.toLowerCase().includes(f) || m.name.toLowerCase().includes(f)
		);
	}

	async onInfoClick() {
		this.state.dialog.visible = true;
		this.state.dialog.loading = true;
		this.state.dialog.error = "";
		this.state.dialog.models = [];
		this.state.dialog.version = "";
		this.state.dialog.filter = "";
		this.state.dialog.expanded = {};
		this.state.dialog.modelData = {};
		try {
			const result = await this.syncService.getOdooExplorer(this.creds);
			this.state.dialog.version = result.version;
			this.state.dialog.models = result.models;
		} catch (e: unknown) {
			this.state.dialog.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.state.dialog.loading = false;
		}
	}

	closeDialog() {
		this.state.dialog.visible = false;
	}

	async copyError() {
		await navigator.clipboard.writeText(this.state.dialog.error);
	}

	openIssue() {
		const body = encodeURIComponent(
			`**URL:** ${this.props.app.url}\n\n**Erreur:**\n\`\`\`\n${this.state.dialog.error}\n\`\`\``
		);
		const url = `https://github.com/TechnoLibre/technolibre_home_mobile/issues/new?labels=bug&body=${body}`;
		window.open(url, "_blank");
	}

	async toggleModel(modelName: string) {
		const wasExpanded = this.state.dialog.expanded[modelName];
		this.state.dialog.expanded[modelName] = !wasExpanded;
		if (!wasExpanded && !this.state.dialog.modelData[modelName]) {
			this.state.dialog.modelData[modelName] = { loading: true, count: -1, fields: [] };
			try {
				const info = await this.syncService.getOdooModelInfo(this.creds, modelName);
				this.state.dialog.modelData[modelName] = { loading: false, count: info.count, fields: info.fields };
			} catch (e: unknown) {
				this.state.dialog.modelData[modelName] = { loading: false, count: -1, fields: [] };
			}
		}
	}
}
