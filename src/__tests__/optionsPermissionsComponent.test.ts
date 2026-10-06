import { describe, it, expect, vi, beforeEach } from "vitest";

// vitest.config.ts aliases @capacitor/core and @capacitor/dialog to the mocks
// in src/__mocks__; a vi.mock() here would automock them away. Geolocation and
// Camera have no alias, so they are mocked by hand.
vi.mock("@capacitor/geolocation", () => ({
	Geolocation: {
		checkPermissions: vi.fn().mockResolvedValue({
			location: "granted",
			coarseLocation: "granted",
		}),
	},
}));
vi.mock("@capacitor/camera", () => ({
	Camera: {
		checkPermissions: vi
			.fn()
			.mockResolvedValue({ camera: "granted", photos: "granted" }),
	},
}));

import { Dialog } from "@capacitor/dialog";
import { Capacitor, __setPluginMock, __clearPluginMocks } from "@capacitor/core";
import { OptionsPermissionsComponent } from "../components/options/permissions/options_permissions_component";

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

function surLAppareil(natif: boolean) {
	(Capacitor as any).isNativePlatform = () => natif;
}

function composant() {
	return new (OptionsPermissionsComponent as any)();
}

/** Le message du dernier Dialog.alert, qui porte le rapport. */
function dernierRapport(): string {
	const appels = (Dialog.alert as any).mock.calls;
	return appels[appels.length - 1][0].message as string;
}

describe("Options › Permissions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__clearPluginMocks();
		stubLocale("en");
		(Dialog.confirm as any).mockResolvedValue({ value: true });
	});

	it("reports the two SMS permissions beside the others", async () => {
		surLAppareil(true);
		__setPluginMock("SmsGateway", {
			getCapabilities: vi.fn().mockResolvedValue({
				hasSendPermission: true,
				hasReceivePermission: true,
			}),
		});

		await composant().onShowPermissionsClick();

		const rapport = dernierRapport();
		expect(rapport).toContain("SMS (send)");
		expect(rapport).toContain("SMS (receive)");
		// Ce qui existait reste : l'ecran ne perd pas GPS ni camera.
		expect(rapport).toContain("Camera");
	});

	it("asks nothing when both permissions are already granted", async () => {
		surLAppareil(true);
		__setPluginMock("SmsGateway", {
			getCapabilities: vi.fn().mockResolvedValue({
				hasSendPermission: true,
				hasReceivePermission: true,
			}),
		});

		await composant().onShowPermissionsClick();

		expect(Dialog.confirm).not.toHaveBeenCalled();
	});

	it("offers to request a missing permission, and requests it on yes", async () => {
		// C'etait le trou : le droit d'envoyer un SMS ne s'obtenait que depuis
		// l'ecran de la passerelle, introuvable pour qui cherche ses
		// permissions ici.
		surLAppareil(true);
		const demande = vi.fn().mockResolvedValue({
			hasSendPermission: true,
			hasReceivePermission: true,
		});
		__setPluginMock("SmsGateway", {
			getCapabilities: vi.fn().mockResolvedValue({
				hasSendPermission: false,
				hasReceivePermission: false,
			}),
			requestSmsPermissions: demande,
		});

		await composant().onShowPermissionsClick();

		expect(Dialog.confirm).toHaveBeenCalledOnce();
		expect(demande).toHaveBeenCalledOnce();
		expect(dernierRapport()).toContain("granted");
	});

	it("requests nothing when the answer is no", async () => {
		surLAppareil(true);
		const demande = vi.fn();
		(Dialog.confirm as any).mockResolvedValue({ value: false });
		__setPluginMock("SmsGateway", {
			getCapabilities: vi.fn().mockResolvedValue({
				hasSendPermission: false,
				hasReceivePermission: false,
			}),
			requestSmsPermissions: demande,
		});

		await composant().onShowPermissionsClick();

		expect(demande).not.toHaveBeenCalled();
	});

	it("says what a second refusal means", async () => {
		// Android cesse de demander apres deux refus : sans cette phrase, on
		// reessaie le bouton indefiniment sans que rien ne se passe.
		surLAppareil(true);
		__setPluginMock("SmsGateway", {
			getCapabilities: vi.fn().mockResolvedValue({
				hasSendPermission: false,
				hasReceivePermission: false,
			}),
			requestSmsPermissions: vi.fn().mockResolvedValue({
				hasSendPermission: false,
				hasReceivePermission: false,
			}),
		});

		await composant().onShowPermissionsClick();

		expect(dernierRapport()).toContain("system settings");
	});

	it("says SMS are unavailable off the device, without failing", async () => {
		surLAppareil(false);

		await composant().onShowPermissionsClick();

		const rapport = dernierRapport();
		expect(rapport).toContain("SMS: unavailable");
		expect(Dialog.confirm).not.toHaveBeenCalled();
	});
});
