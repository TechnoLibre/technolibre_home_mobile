import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";
import { Capacitor } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { SmsGatewayPlugin } from "../../../plugins/smsGatewayPlugin";
import type { SmsCapabilities, SmsGatewayStatus } from "../../../plugins/smsGatewayPlugin";
import { SmsGatewayUtils } from "../../../utils/smsGatewayUtils";

const BREADCRUMBS = [{ label: "Options", url: "/options" }];

/** Rythme de rafraîchissement de l'état, en millisecondes. */
const POLL_MS = 5000;

interface FormState {
	odooBaseUrl: string;
	hmacSecret: string;
	deviceId: string;
	subscriptionId: number;
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
            <button type="button" class="sms-gateway__btn sms-gateway__btn--danger"
                    t-if="state.status.enabled"
                    t-on-click="onStop" t-esc="t('sms_gateway.stop')" />
            <button type="button" class="sms-gateway__btn"
                    t-if="!state.status.hasSendPermission"
                    t-on-click="onRequestPermission" t-esc="t('sms_gateway.request_permission')" />
            <button type="button" class="sms-gateway__btn"
                    t-if="state.status.lastError"
                    t-on-click="onClearError" t-esc="t('sms_gateway.clear_error')" />
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

          <p class="sms-gateway__warning" t-if="isDevelopmentUrl"
             t-esc="t('sms_gateway.warn_dev_url')" />

          <div class="sms-gateway__actions">
            <button type="button" class="sms-gateway__btn" t-on-click="onSave"
                    t-esc="t('sms_gateway.save')" />
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
		});

		onMounted(async () => {
			if (!this.state.native) {
				return;
			}
			await this.refresh();
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

	get isDevelopmentUrl(): boolean {
		return SmsGatewayUtils.isDevelopmentUrl((this.state.form as FormState).odooBaseUrl);
	}

	emptyCaps(): SmsCapabilities {
		return {
			hasSendPermission: false,
			hasReceivePermission: false,
			androidSdk: 0,
			deviceModel: "",
			segmentLimitPerMinute: 30,
			isDefaultSmsApp: false,
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
		if (!SmsGatewayUtils.isSecureUrl(form.odooBaseUrl)) {
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
