import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";
import { Capacitor } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { SmsGatewayPlugin } from "../../../plugins/smsGatewayPlugin";
import type {
	SmsCapabilities,
	SmsGatewayStatus,
	SmsJournalCategory,
	SmsJournalEntry,
} from "../../../plugins/smsGatewayPlugin";
import { SmsGatewayUtils } from "../../../utils/smsGatewayUtils";

const BREADCRUMBS = [{ label: "Options", url: "/options" }];

/** Rythme de rafraîchissement de l'état, en millisecondes. */
const POLL_MS = 5000;

interface FormState {
	odooBaseUrl: string;
	hmacSecret: string;
	deviceId: string;
	subscriptionId: number;
	allowPlainLan: boolean;
}

/**
 * Écran de configuration et de supervision de la passerelle SMS.
 *
 * L'indicateur d'état est délibérément le premier élément de l'écran : sur un
 * canal d'alerte, savoir que la passerelle est muette compte davantage que
 * n'importe quel réglage.
 */
export class OptionsSmsGatewayComponent extends EnhancedComponent {
	static template = xml`
    <div id="options-sms-gateway-component">
      <HeadingComponent title="t('heading.sms_gateway')" breadcrumbs="breadcrumbs" />

      <t t-if="!state.native">
        <p class="sms-gateway__note" t-esc="t('sms_gateway.android_only')" />
      </t>

      <t t-else="">
        <!-- État -->
        <section class="sms-gateway__section" t-att-aria-label="t('sms_gateway.status_title')">
          <div t-att-class="'sms-gateway__banner sms-gateway__banner--' + healthClass">
            <span class="sms-gateway__dot" aria-hidden="true" />
            <span t-esc="healthLabel" />
          </div>

          <dl class="sms-gateway__facts">
            <dt t-esc="t('sms_gateway.fact_service')" />
            <dd t-esc="state.status.running ? t('sms_gateway.yes') : t('sms_gateway.no')" />

            <dt t-esc="t('sms_gateway.fact_connected')" />
            <dd t-esc="state.status.connected ? t('sms_gateway.yes') : t('sms_gateway.no')" />

            <dt t-esc="t('sms_gateway.fact_permission')" />
            <dd t-esc="state.status.hasSendPermission ? t('sms_gateway.yes') : t('sms_gateway.no')" />

            <dt t-esc="t('sms_gateway.fact_sim')" />
            <dd t-esc="state.caps.simReady ? t('sms_gateway.yes') : t('sms_gateway.no')" />

            <dt t-esc="t('sms_gateway.fact_pacing')" />
            <dd t-esc="state.caps.dozeExempt ? t('sms_gateway.pacing_ok') : t('sms_gateway.pacing_degraded')" />

            <dt t-esc="t('sms_gateway.fact_pending')" />
            <dd t-esc="state.status.pending" />

            <dt t-esc="t('sms_gateway.fact_spooled')" />
            <dd t-esc="state.status.spooledReports" />

            <dt t-esc="t('sms_gateway.fact_rate')" />
            <dd t-esc="state.status.segmentsLastMinute + ' / ' + state.status.segmentsPerMinute" />

            <dt t-esc="t('sms_gateway.fact_poll')" />
            <dd t-esc="state.status.pollSeconds + ' s'" />
          </dl>

          <p class="sms-gateway__error" t-if="state.status.lastError">
            <t t-esc="t('sms_gateway.last_error')" />: <t t-esc="state.status.lastError" />
          </p>
          <p class="sms-gateway__error" t-if="state.status.connectionError">
            <t t-esc="t('sms_gateway.connection_error')" />: <t t-esc="state.status.connectionError" />
          </p>

          <div class="sms-gateway__actions">
            <button type="button" class="sms-gateway__btn"
                    t-if="!state.status.enabled"
                    t-on-click="onStart" t-esc="t('sms_gateway.start')" />
            <button type="button" class="sms-gateway__btn"
                    t-if="state.status.enabled and !state.status.running"
                    t-on-click="onStart" t-esc="t('sms_gateway.restart')" />
            <button type="button" class="sms-gateway__btn sms-gateway__btn--danger"
                    t-if="state.status.enabled and state.status.running"
                    t-on-click="onStop" t-esc="t('sms_gateway.stop')" />
            <button type="button" class="sms-gateway__btn"
                    t-if="!state.status.hasSendPermission"
                    t-on-click="onRequestPermission" t-esc="t('sms_gateway.request_permission')" />
            <button type="button" class="sms-gateway__btn"
                    t-if="state.status.lastError"
                    t-on-click="onClearError" t-esc="t('sms_gateway.clear_error')" />
            <button type="button" class="sms-gateway__btn"
                    t-if="!state.caps.dozeExempt"
                    t-on-click="onBatteryExemption"
                    t-esc="t('sms_gateway.fix_pacing')" />
            <button type="button" class="sms-gateway__btn"
                    t-if="!state.caps.canScheduleExactAlarms"
                    t-on-click="onExactAlarms"
                    t-esc="t('sms_gateway.fix_exact_alarms')" />
          </div>
        </section>

        <!-- Avertissements -->
        <p class="sms-gateway__warning" t-esc="t('sms_gateway.warn_rate_limit')" />
        <p class="sms-gateway__warning" t-esc="t('sms_gateway.warn_battery')" />
        <p class="sms-gateway__warning" t-if="state.caps.isDefaultSmsApp"
           t-esc="t('sms_gateway.warn_default_sms_app')" />

        <!-- Configuration -->
        <section class="sms-gateway__section" t-att-aria-label="t('sms_gateway.config_title')">
          <h2 class="sms-gateway__subtitle" t-esc="t('sms_gateway.config_title')" />

          <label class="sms-gateway__field">
            <span t-esc="t('sms_gateway.odoo_url')" />
            <input type="url" inputmode="url" autocapitalize="off" autocomplete="off"
                   placeholder="https://odoo.exemple.org"
                   t-att-value="state.form.odooBaseUrl"
                   t-on-input="(ev) => this.onField('odooBaseUrl', ev)" />
          </label>

          <label class="sms-gateway__field">
            <span t-esc="t('sms_gateway.hmac_secret')" />
            <input type="password" autocapitalize="off" autocomplete="off"
                   t-att-value="state.form.hmacSecret"
                   t-on-input="(ev) => this.onField('hmacSecret', ev)" />
          </label>

          <label class="sms-gateway__field">
            <span t-esc="t('sms_gateway.device_id')" />
            <input type="text" autocapitalize="off" autocomplete="off"
                   t-att-value="state.form.deviceId"
                   t-on-input="(ev) => this.onField('deviceId', ev)" />
          </label>

          <label class="sms-gateway__field" t-if="state.caps.sims.length > 1">
            <span t-esc="t('sms_gateway.sim')" />
            <select t-on-change="(ev) => this.onSimChange(ev)">
              <option value="-1" t-esc="t('sms_gateway.sim_default')"
                      t-att-selected="state.form.subscriptionId === -1" />
              <t t-foreach="state.caps.sims" t-as="sim" t-key="sim.subscriptionId">
                <option t-att-value="sim.subscriptionId"
                        t-att-selected="state.form.subscriptionId === sim.subscriptionId"
                        t-esc="sim.carrier + ' (' + t('sms_gateway.slot') + ' ' + (sim.slot + 1) + ')'" />
              </t>
            </select>
          </label>

          <label class="sms-gateway__check">
            <input type="checkbox" t-att-checked="state.form.allowPlainLan"
                   t-on-change="onTogglePlainLan" />
            <span t-esc="t('sms_gateway.allow_plain_lan')" />
          </label>
          <p class="sms-gateway__warning" t-if="state.form.allowPlainLan"
             t-esc="t('sms_gateway.allow_plain_lan_warning')" />

          <p class="sms-gateway__warning" t-if="isDevelopmentUrl"
             t-esc="t('sms_gateway.warn_dev_url')" />

          <label class="sms-gateway__check">
            <input type="checkbox" t-att-checked="state.demoCallAudio"
                   t-on-change="onToggleDemoAudio" />
            <span t-esc="t('sms_gateway.demo_call_audio')" />
          </label>
          <p class="sms-gateway__warning" t-if="state.demoCallAudio"
             t-esc="t('sms_gateway.demo_call_audio_warning')" />

          <div class="sms-gateway__actions">
            <button type="button" class="sms-gateway__btn" t-on-click="onSave"
                    t-esc="t('sms_gateway.save')" />
          </div>
        </section>

        <section class="sms-gateway__section" t-att-aria-label="t('sms_gateway.journal_title')">
          <h2 class="sms-gateway__subtitle" t-esc="t('sms_gateway.journal_title')" />
          <p class="sms-gateway__hint" t-esc="t('sms_gateway.journal_hint')" />

          <label class="sms-gateway__check">
            <input type="checkbox" t-att-checked="state.keepsBodies"
                   t-on-change="onToggleBodies" />
            <span t-esc="t('sms_gateway.journal_keep_bodies')" />
          </label>
          <p class="sms-gateway__warning" t-if="state.keepsBodies"
             t-esc="t('sms_gateway.journal_keep_bodies_warning')" />

          <div class="sms-gateway__filters">
            <button type="button" class="sms-gateway__chip"
                    t-att-class="{ 'sms-gateway__chip--on': state.category === '' }"
                    t-on-click="() => this.onCategory('')"
                    t-esc="t('sms_gateway.journal_all')" />
            <t t-foreach="categories" t-as="cat" t-key="cat">
              <button type="button" class="sms-gateway__chip"
                      t-att-class="{ 'sms-gateway__chip--on': state.category === cat }"
                      t-on-click="() => this.onCategory(cat)"
                      t-esc="t('sms_gateway.journal_cat_' + cat)" />
            </t>
          </div>

          <p class="sms-gateway__note" t-esc="journalSummary" />

          <ul class="sms-gateway__journal" t-if="state.journal.length > 0">
            <t t-foreach="state.journal" t-as="entry" t-key="entry.id">
              <li t-att-class="'sms-gateway__event sms-gateway__event--' + entry.level">
                <span class="sms-gateway__event-at" t-esc="formatAt(entry.at)" />
                <span class="sms-gateway__event-msg" t-esc="entry.message" />
                <span class="sms-gateway__event-uuid" t-if="entry.smsUuid"
                      t-esc="entry.smsUuid" />
                <span class="sms-gateway__event-detail" t-if="entry.detail"
                      t-esc="entry.detail" />
              </li>
            </t>
          </ul>
          <p class="sms-gateway__hint" t-if="state.journal.length === 0"
             t-esc="t('sms_gateway.journal_empty')" />

          <div class="sms-gateway__actions">
            <button type="button" class="sms-gateway__btn sms-gateway__btn--danger"
                    t-on-click="onClearJournal"
                    t-esc="t('sms_gateway.journal_clear')" />
          </div>
        </section>

        <p class="sms-gateway__note" t-esc="deviceSummary" />
      </t>
    </div>
  `;

	static components = { HeadingComponent };

	private timer: ReturnType<typeof setInterval> | null = null;

	get breadcrumbs() {
		return BREADCRUMBS;
	}

	setup() {
		this.state = useState({
			native: Capacitor.isNativePlatform(),
			status: this.emptyStatus(),
			caps: this.emptyCaps(),
			form: {
				odooBaseUrl: "",
				hmacSecret: "",
				deviceId: "",
				subscriptionId: -1,
			} as FormState,
			journal: [] as SmsJournalEntry[],
			journalCount: 0,
			journalBytes: 0,
			keepsBodies: false,
			demoCallAudio: false,
			relances: 0,
			category: "",
		});

		onMounted(async () => {
			if (!this.state.native) {
				return;
			}
			await this.refresh();
			await this.loadJournal();
			this.timer = setInterval(() => void this.refresh(), POLL_MS);
		});

		onWillUnmount(() => {
			if (this.timer !== null) {
				clearInterval(this.timer);
				this.timer = null;
			}
		});
	}

	emptyStatus(): SmsGatewayStatus {
		return {
			enabled: false,
			configured: false,
			running: false,
			connected: false,
			lastPollAt: 0,
			pending: 0,
			spooledReports: 0,
			segmentsLastMinute: 0,
			segmentsPerMinute: 24,
			pollSeconds: 60,
			hasSendPermission: false,
			lastError: "",
			connectionError: "",
		};
	}

	static readonly CATEGORIES: SmsJournalCategory[] = [
		"service", "cycle", "send", "receipt", "inbound", "network", "config",
	];

	/** Seuil haut de la purge côté Android, pour la jauge d'occupation. */
	static readonly JOURNAL_HIGH_WATER = 10 * 1024 * 1024;

	get categories(): SmsJournalCategory[] {
		return OptionsSmsGatewayComponent.CATEGORIES;
	}

	/** Nombre d'entrées et place occupée, sur une ligne. */
	get journalSummary(): string {
		const used = SmsGatewayUtils.formatBytes(this.state.journalBytes as number);
		return `${this.state.journalCount} ${this.t("sms_gateway.journal_entries")} — ${used}`;
	}

	/** Heure locale seule : le journal se lit dans la journée en cours. */
	formatAt(at: number): string {
		return new Date(at).toLocaleTimeString();
	}

	async loadJournal(): Promise<void> {
		try {
			const page = await SmsGatewayPlugin.journalEntries({
				category: (this.state.category as SmsJournalCategory) || undefined,
				limit: 200,
			});
			this.state.journal = page.entries ?? [];
			this.state.journalCount = page.count ?? 0;
			this.state.journalBytes = page.usedBytes ?? 0;
			this.state.keepsBodies = page.keepsBodies ?? false;
		} catch {
			// Un journal illisible ne doit pas masquer l'état de la passerelle,
			// qui est la raison d'être de l'écran.
			this.state.journal = [];
		}
	}

	async onCategory(category: string): Promise<void> {
		this.state.category = category;
		await this.loadJournal();
	}

	/**
	 * Active la mélodie de démonstration pendant les appels.
	 *
	 * Réglage de démonstration, pas de production : Android ne permet pas
	 * d'injecter du son dans un appel cellulaire, on passe par le
	 * haut-parleur et le microphone. L'annulation d'écho dégrade le rendu.
	 */
	async onToggleDemoAudio(ev: Event): Promise<void> {
		const actif = (ev.target as HTMLInputElement).checked;
		const form = this.state.form as FormState;
		await SmsGatewayPlugin.configure({ ...form, demoCallAudio: actif });
		this.state.demoCallAudio = actif;
	}

	async onToggleBodies(ev: Event): Promise<void> {
		const keep = (ev.target as HTMLInputElement).checked;
		const form = this.state.form as FormState;
		await SmsGatewayPlugin.configure({ ...form, journalKeepsBodies: keep });
		this.state.keepsBodies = keep;
	}

	/**
	 * Efface le journal, après confirmation.
	 *
	 * L'effacement est irréversible et c'est précisément ce qu'on garde pour
	 * diagnostiquer une panne : la confirmation n'est pas une politesse.
	 */
	async onClearJournal(): Promise<void> {
		const { value } = await Dialog.confirm({
			title: this.t("sms_gateway.journal_clear"),
			message: this.t("sms_gateway.journal_clear_confirm"),
		});
		if (!value) {
			return;
		}
		await SmsGatewayPlugin.clearJournal();
		await this.loadJournal();
	}

	/**
	 * Ouvre le réglage de dispense de batterie.
	 *
	 * Sans elle, Android regroupe les réveils et un message urgent peut
	 * attendre des minutes. On ouvre le réglage plutôt que de demander la
	 * dispense directement : c'est le chemin que le système accepte.
	 */
	async onBatteryExemption(): Promise<void> {
		try {
			await SmsGatewayPlugin.requestBatteryExemption();
		} catch (error) {
			await Dialog.alert({
				title: this.t("sms_gateway.fix_pacing"),
				message: String(error),
			});
		}
	}

	async onExactAlarms(): Promise<void> {
		try {
			await SmsGatewayPlugin.requestExactAlarms();
		} catch (error) {
			await Dialog.alert({
				title: this.t("sms_gateway.fix_exact_alarms"),
				message: String(error),
			});
		}
	}

	get isDevelopmentUrl(): boolean {
		const form = this.state.form as FormState;
		return SmsGatewayUtils.isDevelopmentUrl(
			form.odooBaseUrl,
			form.allowPlainLan,
		);
	}

	/**
	 * Bascule la tolérance du réseau local en clair.
	 *
	 * Le réglage vit côté natif, parce que c'est le plugin qui valide l'URL
	 * au moment d'enregistrer : le garder ici seulement laisserait l'écran
	 * afficher une case cochée que la validation ignorerait.
	 */
	onTogglePlainLan(ev: Event): void {
		// On note que l'utilisateur y a touché : sinon le rafraîchissement
		// périodique écraserait son choix avant qu'il ait pu enregistrer.
		this.state.touchedPlainLan = true;
		(this.state.form as FormState).allowPlainLan =
			(ev.target as HTMLInputElement).checked;
	}

	emptyCaps(): SmsCapabilities {
		return {
			hasSendPermission: false,
			hasReceivePermission: false,
			androidSdk: 0,
			deviceModel: "",
			segmentLimitPerMinute: 30,
			isDefaultSmsApp: false,
			dozeExempt: true,
			canScheduleExactAlarms: true,
			allowPlainLan: false,
			demoCallAudio: false,
			simReady: false,
			sims: [],
		};
	}

	/**
	 * Trois états seulement, parce qu'un écran d'alerte doit se lire d'un coup
	 * d'œil : arrêtée, en panne, ou en service. La règle vit dans
	 * {@link SmsGatewayUtils} pour être testable hors composant.
	 */
	get healthClass(): string {
		return SmsGatewayUtils.health(this.state.status as SmsGatewayStatus);
	}

	/** Action à proposer : la règle vit dans {@link SmsGatewayUtils}. */
	get primaryAction(): "start" | "restart" | "stop" {
		return SmsGatewayUtils.primaryAction(this.state.status as SmsGatewayStatus);
	}

	get healthLabel(): string {
		const map: Record<string, string> = {
			off: this.t("sms_gateway.state_off"),
			error: this.t("sms_gateway.state_error"),
			ok: this.t("sms_gateway.state_ok"),
		};
		return map[this.healthClass];
	}

	get deviceSummary(): string {
		const caps = this.state.caps as SmsCapabilities;
		if (!caps.deviceModel) {
			return "";
		}
		return this.t("sms_gateway.device_summary", {
			model: caps.deviceModel,
			sdk: caps.androidSdk,
			limit: caps.segmentLimitPerMinute,
		});
	}

	async refresh(): Promise<void> {
		try {
			const [status, caps] = await Promise.all([
				SmsGatewayPlugin.getStatus(),
				SmsGatewayPlugin.getCapabilities(),
			]);
			Object.assign(this.state.status, status);
			Object.assign(this.state.caps, caps);
			// La case suit ce que le natif retient. Sans cette reprise, rouvrir
			// l'ecran afficherait une case decochee alors que l'exception est
			// active — et on chercherait longtemps pourquoi le Wi-Fi marche.
			if (!this.state.touchedPlainLan) {
				(this.state.form as FormState).allowPlainLan = Boolean(
					caps.allowPlainLan,
				);
			}
			// Même raison : la case doit refléter ce que le natif retient,
			// sinon rouvrir l'écran la montrerait décochée pendant que la
			// mélodie joue.
			this.state.demoCallAudio = Boolean(caps.demoCallAudio);

			await this.releverSiTombee();
		} catch (error: unknown) {
			console.warn("[sms-gateway] état indisponible", error);
		}
	}

	onField(field: keyof FormState, event: Event): void {
		const target = event.target as HTMLInputElement;
		(this.state.form as any)[field] = target.value;
	}

	onSimChange(event: Event): void {
		const target = event.target as HTMLSelectElement;
		this.state.form.subscriptionId = Number.parseInt(target.value, 10);
	}

	async onSave(): Promise<void> {
		const form = this.state.form as FormState;
		if (SmsGatewayUtils.missingConfigFields(form).length > 0) {
			await Dialog.alert({
				title: this.t("sms_gateway.save_error"),
				message: this.t("sms_gateway.fields_required"),
			});
			return;
		}
		if (!SmsGatewayUtils.isSecureUrl(form.odooBaseUrl, form.allowPlainLan)) {
			await Dialog.alert({
				title: this.t("sms_gateway.save_error"),
				message: this.t("sms_gateway.https_required"),
			});
			return;
		}
		try {
			await SmsGatewayPlugin.configure({
				odooBaseUrl: form.odooBaseUrl.trim(),
				hmacSecret: form.hmacSecret.trim(),
				deviceId: form.deviceId.trim(),
				subscriptionId: form.subscriptionId,
			});
			await SmsGatewayPlugin.kick();
			await this.refresh();
			await Dialog.alert({
				title: this.t("sms_gateway.saved"),
				message: this.t("sms_gateway.saved_message"),
			});
		} catch (error: unknown) {
			await Dialog.alert({
				title: this.t("sms_gateway.save_error"),
				message: String(error instanceof Error ? error.message : error),
			});
		}
	}

	/**
	 * Relance la passerelle si elle est activée mais que le service est mort.
	 *
	 * C'est le cas observé après une réinstallation : la préférence dit « en
	 * service », aucun processus ne tourne, et l'écran attendait qu'on
	 * devine qu'il faut un cycle arrêt/démarrage. Constater la panne sans y
	 * remédier n'a aucun intérêt — on relève.
	 *
	 * On ne relance PAS en boucle : deux tentatives ratées d'affilée et on
	 * s'arrête, sinon un service qui refuse de démarrer serait rappelé toutes
	 * les quelques secondes en vidant la batterie. Le filet natif
	 * (`SmsWatchdogJob`) reprend le relais au quart d'heure suivant.
	 */
	async releverSiTombee(): Promise<void> {
		const status = this.state.status as SmsGatewayStatus;
		if (status.running || !status.enabled) {
			this.state.relances = 0;
		}
		if (!SmsGatewayUtils.shouldRevive(status, this.state.relances)) {
			return;
		}
		this.state.relances += 1;
		try {
			await SmsGatewayPlugin.startGateway();
			// Le natif journalise la relance : rien à écrire ici, et deux
			// traces de la même chose se contrediraient un jour.
			await this.loadJournal();
		} catch (error: unknown) {
			console.warn("[sms-gateway] relance impossible", error);
		}
	}

	async onStart(): Promise<void> {
		try {
			await SmsGatewayPlugin.startGateway();
			await this.refresh();
		} catch (error: unknown) {
			await Dialog.alert({
				title: this.t("sms_gateway.start_error"),
				message: String(error instanceof Error ? error.message : error),
			});
		}
	}

	async onStop(): Promise<void> {
		const { value } = await Dialog.confirm({
			title: this.t("sms_gateway.stop"),
			message: this.t("sms_gateway.stop_confirm"),
		});
		if (!value) {
			return;
		}
		await SmsGatewayPlugin.stopGateway();
		await this.refresh();
	}

	async onRequestPermission(): Promise<void> {
		const result = await SmsGatewayPlugin.requestSmsPermissions();
		if (!result.hasSendPermission) {
			await Dialog.alert({
				title: this.t("sms_gateway.permission_denied"),
				message: this.t("sms_gateway.permission_denied_message"),
			});
		}
		await this.refresh();
	}

	async onClearError(): Promise<void> {
		await SmsGatewayPlugin.clearLastError();
		await this.refresh();
	}
}
