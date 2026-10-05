import { describe, it, expect, vi, beforeEach } from "vitest";

import { __setPluginMock, __clearPluginMocks } from "@capacitor/core";
import { OptionsSmsGatewayComponent } from "../components/options/sms_gateway/options_sms_gateway_component";

/** localStorage does not exist in the node environment; i18n reads it. */
function stubLocale(locale: "fr" | "en" = "en") {
	const store: Record<string, string> = { app_lang: locale };
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store[k] ?? null,
		setItem: (k: string, v: string) => {
			store[k] = v;
		},
		removeItem: (k: string) => {
			delete store[k];
		},
		clear: () => {
			for (const k of Object.keys(store)) delete store[k];
		},
	});
}

/** The Owl mock makes onMounted a no-op, so setup() then load by hand. */
function composant() {
	const c = new (OptionsSmsGatewayComponent as any)();
	c.setup();
	return c;
}

describe("Options › Passerelle SMS — pre-remplissage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__clearPluginMocks();
		stubLocale("en");
	});

	it("fills the form with what is stored", async () => {
		// Sans cette lecture les trois champs partent vides a chaque
		// ouverture, et rien ne distingue « pas configure » de « configure
		// ailleurs » — par le cable, par exemple.
		__setPluginMock("SmsGateway", {
			getConfig: vi.fn().mockResolvedValue({
				odooBaseUrl: "https://odoo.example/",
				deviceId: "poste-01",
				subscriptionId: 2,
				hasSecret: true,
			}),
		});

		const c = composant();
		await c.chargerConfiguration();

		expect(c.state.form.odooBaseUrl).toBe("https://odoo.example/");
		expect(c.state.form.deviceId).toBe("poste-01");
		expect(c.state.form.subscriptionId).toBe(2);
	});

	it("never puts the key in the form", async () => {
		// Elle traverserait le pont et s'installerait dans le document d'une
		// page web, alors que tout son interet est de ne pas circuler.
		__setPluginMock("SmsGateway", {
			getConfig: vi.fn().mockResolvedValue({
				odooBaseUrl: "https://odoo.example/",
				deviceId: "poste-01",
				subscriptionId: -1,
				hasSecret: true,
			}),
		});

		const c = composant();
		await c.chargerConfiguration();

		expect(c.state.form.hmacSecret).toBe("");
		expect(c.state.hasSecret).toBe(true);
		expect(JSON.stringify(c.state)).not.toContain("hmacSecret\":\"a");
	});

	it("tells a missing key from a hidden one", async () => {
		__setPluginMock("SmsGateway", {
			getConfig: vi.fn().mockResolvedValue({
				odooBaseUrl: "",
				deviceId: "",
				subscriptionId: -1,
				hasSecret: false,
			}),
		});

		const c = composant();
		await c.chargerConfiguration();

		expect(c.state.hasSecret).toBe(false);
	});

	it("warns about RCS on the gateway screen, in both languages", async () => {
		// Un message RCS n'entre jamais dans la pile SMS : la passerelle ne
		// le voit pas, et rien ne signale la perte. L'avertissement est la
		// seule chose qui previent une panne muette.
		const fr = (await import("../i18n/fr")).translations;
		const en = (await import("../i18n/en")).translations;
		for (const table of [fr, en]) {
			const texte = table["sms_gateway.warn_rcs"];
			expect(texte).toBeTruthy();
			expect(texte).toMatch(/RCS/);
		}
		expect(fr["sms_gateway.warn_rcs"]).not.toBe(
			en["sms_gateway.warn_rcs"],
		);
	});

	it("keeps the screen usable when the plugin refuses", async () => {
		__setPluginMock("SmsGateway", {
			getConfig: vi.fn().mockRejectedValue(new Error("pas de greffon")),
		});

		const c = composant();
		await expect(c.chargerConfiguration()).resolves.toBeUndefined();
		expect(c.state.form.odooBaseUrl).toBe("");
	});
});
