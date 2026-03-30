import { onMounted, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { StorageConstants } from "../../../constants/storage";
import { SyncCredentials } from "../../../services/syncService";
import { Application } from "../../../models/application";

export interface SyncConfig {
	appUrl: string;
	appUsername: string;
	database: string;
	autoSync: boolean;
	pollIntervalMinutes: number;
	ntfyUrl: string;
	ntfyTopic: string;
}

const DEFAULT_CONFIG: SyncConfig = {
	appUrl: "",
	appUsername: "",
	database: "",
	autoSync: false,
	pollIntervalMinutes: 5,
	ntfyUrl: "",
	ntfyTopic: "",
};

export class OptionsSyncComponent extends EnhancedComponent {
	static template = xml`
		<li class="options-list__item options-sync">
			<div class="options-sync__header" t-on-click="toggleExpanded">
				<span>Synchronisation Odoo</span>
				<span class="options-sync__status" t-esc="statusLabel" />
				<span t-esc="state.expanded ? '▲' : '▼'" />
			</div>

			<div t-if="state.expanded" class="options-sync__body">

				<label class="options-sync__label">Application Odoo</label>
				<select class="options-sync__select" t-on-change="onAppChange">
					<option value="">— Choisir une application —</option>
					<t t-foreach="state.apps" t-as="app" t-key="app.url + app.username">
						<option
							t-att-value="app.url + '|' + app.username"
							t-att-selected="state.config.appUrl === app.url and state.config.appUsername === app.username"
							t-esc="app.url + ' (' + app.username + ')'"
						/>
					</t>
				</select>

				<label class="options-sync__label">Base de données Odoo</label>
				<input
					class="options-sync__input"
					type="text"
					placeholder="ex: ma_base"
					t-att-value="state.config.database"
					t-on-input="onDatabaseInput"
				/>

				<label class="options-sync__label">Synchronisation automatique</label>
				<label class="options-sync__toggle">
					<input
						type="checkbox"
						t-att-checked="state.config.autoSync"
						t-on-change="onAutoSyncChange"
					/>
					<span t-esc="state.config.autoSync ? 'Activée' : 'Désactivée'" />
				</label>

				<label class="options-sync__label" t-if="state.config.autoSync">
					Intervalle de synchronisation
				</label>
				<select
					t-if="state.config.autoSync"
					class="options-sync__select"
					t-on-change="onIntervalChange"
				>
					<option value="1"  t-att-selected="state.config.pollIntervalMinutes === 1">1 minute</option>
					<option value="5"  t-att-selected="state.config.pollIntervalMinutes === 5">5 minutes</option>
					<option value="15" t-att-selected="state.config.pollIntervalMinutes === 15">15 minutes</option>
					<option value="30" t-att-selected="state.config.pollIntervalMinutes === 30">30 minutes</option>
				</select>

				<details class="options-sync__ntfy">
					<summary class="options-sync__label options-sync__ntfy-summary">
						🔔 Notifications NTFY (optionnel)
					</summary>
					<div class="options-sync__ntfy-body">
						<label class="options-sync__label">URL du serveur NTFY</label>
						<input
							class="options-sync__input"
							type="url"
							placeholder="ex: https://ntfy.sh"
							t-att-value="state.config.ntfyUrl"
							t-on-input="onNtfyUrlInput"
						/>
						<label class="options-sync__label">Topic NTFY</label>
						<input
							class="options-sync__input"
							type="text"
							placeholder="ex: erplibre-monentreprise"
							t-att-value="state.config.ntfyTopic"
							t-on-input="onNtfyTopicInput"
						/>
						<p class="options-sync__ntfy-hint">
							Configurez le même topic dans Odoo (Paramètres → ERPLibre Mobile)
							pour recevoir des notifications en temps réel.
							Pour les notifications en arrière-plan, installez l'app NTFY.
						</p>
					</div>
				</details>

				<div class="options-sync__actions">
					<button
						class="options-sync__btn options-sync__btn--save"
						t-on-click="saveConfig"
					>Enregistrer</button>
					<button
						class="options-sync__btn options-sync__btn--sync"
						t-att-disabled="!isConfigured or state.isSyncing"
						t-on-click="syncNow"
					>
						<t t-if="state.isSyncing">⟳ Sync…</t>
						<t t-else="">☁ Sync maintenant</t>
					</button>
				</div>

				<div t-if="state.lastResult" class="options-sync__result">
					<t t-esc="state.lastResult" />
				</div>
			</div>
		</li>
	`;

	setup() {
		this.state = useState({
			expanded: false,
			apps: [] as Application[],
			config: { ...DEFAULT_CONFIG },
			isSyncing: false,
			lastResult: "",
		});
		onMounted(() => {
			this.loadApps();
			this.loadConfig();
		});
	}

	get isConfigured(): boolean {
		const c = this.state.config;
		return !!(c.appUrl && c.appUsername && c.database);
	}

	get statusLabel(): string {
		if (!this.isConfigured) return "Non configurée";
		return this.state.config.autoSync
			? `Auto (${this.state.config.pollIntervalMinutes} min)`
			: "Manuelle";
	}

	toggleExpanded() {
		this.state.expanded = !this.state.expanded;
	}

	onAppChange(event: Event) {
		const val = (event.target as HTMLSelectElement).value;
		if (!val) {
			this.state.config.appUrl = "";
			this.state.config.appUsername = "";
			return;
		}
		const [url, username] = val.split("|");
		this.state.config.appUrl = url;
		this.state.config.appUsername = username;
	}

	onDatabaseInput(event: Event) {
		this.state.config.database = (event.target as HTMLInputElement).value.trim();
	}

	onAutoSyncChange(event: Event) {
		this.state.config.autoSync = (event.target as HTMLInputElement).checked;
	}

	onIntervalChange(event: Event) {
		this.state.config.pollIntervalMinutes = parseInt(
			(event.target as HTMLSelectElement).value,
			10
		);
	}

	onNtfyUrlInput(event: Event) {
		this.state.config.ntfyUrl = (event.target as HTMLInputElement).value.trim();
	}

	onNtfyTopicInput(event: Event) {
		this.state.config.ntfyTopic = (event.target as HTMLInputElement).value.trim();
	}

	async saveConfig() {
		await SecureStoragePlugin.set({
			key: StorageConstants.SYNC_CONFIG_KEY,
			value: JSON.stringify(this.state.config),
		});
		// Restart polling and NTFY with new settings
		if ("notificationService" in this.env) {
			await (this.env as any).notificationService.reload();
		}
		await Dialog.alert({ message: "Configuration de sync enregistrée." });
	}

	async syncNow() {
		if (!this.isConfigured || this.state.isSyncing) return;

		const app = this.state.apps.find(
			(a) => a.url === this.state.config.appUrl && a.username === this.state.config.appUsername
		);
		if (!app) {
			await Dialog.alert({ message: "Application introuvable dans la liste." });
			return;
		}

		this.state.isSyncing = true;
		this.state.lastResult = "";
		try {
			const creds: SyncCredentials = {
				odooUrl: this.state.config.appUrl,
				username: app.username,
				password: app.password,
				database: this.state.config.database,
			};
			const result = await this.syncService.syncAll(creds);
			this.state.lastResult =
				`✓ ${result.pushed} envoyée(s), ${result.pulled} reçue(s)` +
				(result.errors.length ? ` — ${result.errors.length} erreur(s)` : "");
		} catch (e: unknown) {
			this.state.lastResult = `✗ ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			this.state.isSyncing = false;
		}
	}

	private async loadApps() {
		this.state.apps = await this.appService.getApps();
	}

	private async loadConfig() {
		try {
			const result = await SecureStoragePlugin.get({
				key: StorageConstants.SYNC_CONFIG_KEY,
			});
			this.state.config = { ...DEFAULT_CONFIG, ...JSON.parse(result.value) };
		} catch {
			// No config yet — use defaults
		}
	}
}
