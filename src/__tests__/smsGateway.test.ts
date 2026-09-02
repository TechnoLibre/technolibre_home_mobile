import { describe, expect, it, afterEach } from "vitest";
import {
	ANDROID_SEGMENT_LIMIT_PER_MINUTE,
	SmsGatewayUtils,
} from "../utils/smsGatewayUtils";
import type { SmsGatewayStatus } from "../plugins/smsGatewayPlugin";
import { translations as fr } from "../i18n/fr";
import { translations as en } from "../i18n/en";
// @ts-ignore — mock module, resolved by vitest aliasing
import { __setPluginMock, __clearPluginMocks, registerPlugin } from "../__mocks__/@capacitor/core";

function status(overrides: Partial<SmsGatewayStatus> = {}): SmsGatewayStatus {
	return {
		enabled: true,
		configured: true,
		running: true,
		connected: true,
		lastPollAt: 0,
		pending: 0,
		spooledReports: 0,
		segmentsLastMinute: 0,
		segmentsPerMinute: 24,
		pollSeconds: 60,
		hasSendPermission: true,
		lastError: "",
		connectionError: "",
		...overrides,
	};
}

describe("SmsGatewayUtils.primaryAction", () => {
	it("propose d'arrêter quand le service tourne vraiment", () => {
		expect(SmsGatewayUtils.primaryAction(status())).toBe("stop");
	});

	it("propose de démarrer quand la passerelle est éteinte", () => {
		expect(SmsGatewayUtils.primaryAction(status({ enabled: false }))).toBe("start");
	});

	it("propose de RELANCER quand la préférence ment sur l'état réel", () => {
		// Le cas observé après une réinstallation : `enabled` reste vrai, le
		// processus est mort. L'écran proposait « arrêter » ce qui n'existait
		// plus, et il fallait deviner le cycle arrêt/démarrage.
		expect(
			SmsGatewayUtils.primaryAction(status({ enabled: true, running: false })),
		).toBe("restart");
	});

	it("ne propose jamais d'arrêter un service absent", () => {
		for (const connected of [true, false]) {
			expect(
				SmsGatewayUtils.primaryAction(status({ running: false, connected })),
			).not.toBe("stop");
		}
	});
});

describe("SmsGatewayUtils.shouldRevive", () => {
	it("relève une passerelle activée dont le service est mort", () => {
		expect(SmsGatewayUtils.shouldRevive(status({ running: false }), 0)).toBe(true);
	});

	it("ne touche pas à une passerelle qui tourne", () => {
		expect(SmsGatewayUtils.shouldRevive(status(), 0)).toBe(false);
	});

	it("ne rallume JAMAIS ce que l'utilisatrice vient d'éteindre", () => {
		// Garde-fou central : sans lui, appuyer sur « Arrêter » relancerait la
		// passerelle au rafraîchissement suivant, et le bouton paraîtrait cassé.
		expect(
			SmsGatewayUtils.shouldRevive(status({ enabled: false, running: false }), 0),
		).toBe(false);
	});

	it("abandonne après deux tentatives ratées", () => {
		const down = status({ running: false });
		expect(SmsGatewayUtils.shouldRevive(down, 1)).toBe(true);
		expect(SmsGatewayUtils.shouldRevive(down, 2)).toBe(false);
		expect(SmsGatewayUtils.shouldRevive(down, 99)).toBe(false);
	});
});

describe("SmsGatewayUtils.health", () => {
	it("reports ok only when everything is in place", () => {
		expect(SmsGatewayUtils.health(status())).toBe("ok");
	});

	it("reports off when the gateway was never started", () => {
		expect(SmsGatewayUtils.health(status({ enabled: false }))).toBe("off");
		// Even a fully broken gateway reads as "off" while disabled: the user
		// stopped it on purpose, that is not a fault to alarm about.
		expect(
			SmsGatewayUtils.health(status({ enabled: false, running: false, connected: false }))
		).toBe("off");
	});

	it("treats a started-but-disconnected gateway as broken, not running", () => {
		// This is the case that must never show green: the service is up but the
		// server is unreachable, so no job arrives and nobody would know.
		expect(SmsGatewayUtils.health(status({ connected: false }))).toBe("error");
		expect(SmsGatewayUtils.health(status({ running: false }))).toBe("error");
	});

	it("treats a revoked send permission as broken", () => {
		// Android revokes permissions of apps unused for a few months. The
		// gateway would keep running and silently send nothing.
		expect(SmsGatewayUtils.health(status({ hasSendPermission: false }))).toBe("error");
	});
});

describe("SmsGatewayUtils.estimateSeconds", () => {
	it("estimates a single segment as under a rate window", () => {
		expect(SmsGatewayUtils.estimateSeconds(1, 24)).toBe(3);
	});

	it("estimates a 40-recipient GSM-7 send at about 100 seconds", () => {
		expect(SmsGatewayUtils.estimateSeconds(40, 24)).toBe(100);
	});

	it("doubles the estimate when the message falls back to UCS-2", () => {
		// An accented French message takes two segments per recipient.
		const gsm7 = SmsGatewayUtils.estimateSeconds(40, 24);
		const ucs2 = SmsGatewayUtils.estimateSeconds(80, 24);
		expect(ucs2).toBe(gsm7 * 2);
		expect(ucs2).toBeGreaterThan(180);
	});

	it("never divides by zero", () => {
		expect(SmsGatewayUtils.estimateSeconds(10, 0)).toBe(600);
		expect(SmsGatewayUtils.estimateSeconds(0, 24)).toBe(0);
	});
});

describe("SmsGatewayUtils.isRateSane", () => {
	it("refuses a rate above the Android system limit", () => {
		expect(SmsGatewayUtils.isRateSane(ANDROID_SEGMENT_LIMIT_PER_MINUTE)).toBe(true);
		expect(SmsGatewayUtils.isRateSane(ANDROID_SEGMENT_LIMIT_PER_MINUTE + 1)).toBe(false);
		expect(SmsGatewayUtils.isRateSane(0)).toBe(false);
	});
});

describe("SmsGatewayUtils configuration checks", () => {
	const complete = {
		odooBaseUrl: "https://odoo.example.org",
		hmacSecret: "secret",
		deviceId: "device",
	};

	it("accepts a complete configuration", () => {
		expect(SmsGatewayUtils.missingConfigFields(complete)).toEqual([]);
	});

	it("names every missing field", () => {
		expect(SmsGatewayUtils.missingConfigFields({ ...complete, hmacSecret: "  " }))
			.toEqual(["hmacSecret"]);
		expect(SmsGatewayUtils.missingConfigFields({
			odooBaseUrl: "", hmacSecret: "", deviceId: "",
		})).toHaveLength(3);
	});

	it("requires HTTPS", () => {
		expect(SmsGatewayUtils.isSecureUrl("https://odoo.example.org")).toBe(true);
		expect(SmsGatewayUtils.isSecureUrl("http://odoo.example.org")).toBe(false);
		expect(SmsGatewayUtils.isSecureUrl("odoo.example.org")).toBe(false);
		expect(SmsGatewayUtils.isSecureUrl("")).toBe(false);
	});

	it("tolerates non-routable addresses for development only", () => {
		// 10.0.2.2 is the host machine as seen from an Android emulator. These
		// addresses never leave the machine, so the carve-out cannot be used to
		// expose phone numbers on a network.
		for (const url of ["http://10.0.2.2:8069", "http://127.0.0.1:8069", "http://localhost:8069"]) {
			expect(SmsGatewayUtils.isSecureUrl(url), url).toBe(true);
			expect(SmsGatewayUtils.isDevelopmentUrl(url), url).toBe(true);
		}
		// A routable address must not sneak through the carve-out.
		expect(SmsGatewayUtils.isSecureUrl("http://10.0.2.20:8069")).toBe(false);
		expect(SmsGatewayUtils.isSecureUrl("http://evil.com/10.0.2.2")).toBe(false);
		expect(SmsGatewayUtils.isDevelopmentUrl("https://odoo.example.org")).toBe(false);
	});
});

describe("SMS gateway translations", () => {
	const frKeys = Object.keys(fr).filter((key) => key.startsWith("sms_gateway."));

	it("ships every gateway string in both languages", () => {
		expect(frKeys.length).toBeGreaterThan(30);
		for (const key of frKeys) {
			expect(en[key], `missing English string for ${key}`).toBeTruthy();
		}
	});

	it("keeps the placeholders identical across languages", () => {
		for (const key of frKeys) {
			const placeholders = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort();
			expect(placeholders(en[key]), `placeholder mismatch on ${key}`)
				.toEqual(placeholders(fr[key]));
		}
	});
});

describe("Capacitor plugin mock registry", () => {
	afterEach(() => __clearPluginMocks());

	it("routes calls to the registered implementation", async () => {
		__setPluginMock("SmsGateway", {
			getStatus: async () => status({ pending: 7 }),
		});
		const plugin = registerPlugin<any>("SmsGateway");
		await expect(plugin.getStatus()).resolves.toMatchObject({ pending: 7 });
	});

	it("fails loudly on an unmocked method instead of returning undefined", async () => {
		const plugin = registerPlugin<any>("SmsGateway");
		await expect(plugin.startGateway()).rejects.toThrow(/is not mocked/);
	});

	it("keeps the RawHttp post fallback working", () => {
		const plugin = registerPlugin<any>("RawHttp");
		expect(typeof plugin.post).toBe("function");
	});
});

describe("SmsGatewayUtils.formatBytes", () => {
	it("reste en octets sous le kibioctet", () => {
		expect(SmsGatewayUtils.formatBytes(0)).toBe("0 o");
		expect(SmsGatewayUtils.formatBytes(999)).toBe("999 o");
	});

	it("utilise des unites binaires, pas decimales", () => {
		// 10 Mio exactement : c'est le seuil haut de la purge. Une division par
		// 1000 afficherait 10,5 Mo au moment ou le service en compte 10.
		expect(SmsGatewayUtils.formatBytes(10 * 1024 * 1024)).toBe("10 Mio");
		expect(SmsGatewayUtils.formatBytes(7 * 1024 * 1024)).toBe("7.0 Mio");
	});

	it("refuse les valeurs absurdes plutot que d'afficher NaN", () => {
		expect(SmsGatewayUtils.formatBytes(-1)).toBe("—");
		expect(SmsGatewayUtils.formatBytes(Number.NaN)).toBe("—");
	});
});

describe("SmsGatewayUtils.journalFill", () => {
	const high = 10 * 1024 * 1024;

	it("rend la part consommee", () => {
		expect(SmsGatewayUtils.journalFill(high / 2, high)).toBeCloseTo(0.5);
	});

	it("borne a 1 quand le journal a depasse le seuil", () => {
		// La verification n'a lieu qu'une insertion sur deux cents : un
		// depassement bref est normal et ne doit pas afficher une jauge pleine
		// a 130 %.
		expect(SmsGatewayUtils.journalFill(high * 1.3, high)).toBe(1);
	});

	it("ne divise pas par zero", () => {
		expect(SmsGatewayUtils.journalFill(1000, 0)).toBe(0);
	});
});

describe("SmsGatewayUtils reseau local en clair", () => {
	const LAN = "http://192.168.1.38:8169";

	it("refuse le reseau local tant que l'exception n'est pas accordee", () => {
		// C'est le defaut, et il compte : sur un Wi-Fi partage, numeros et
		// messages sont lisibles par quiconque est sur le meme reseau.
		expect(SmsGatewayUtils.isSecureUrl(LAN)).toBe(false);
	});

	it("accepte le reseau local une fois l'exception accordee", () => {
		expect(SmsGatewayUtils.isSecureUrl(LAN, true)).toBe(true);
	});

	it("accepte les trois plages privees", () => {
		for (const url of [
			"http://10.1.2.3:8169",
			"http://172.16.0.5:8069",
			"http://172.31.255.254",
			"http://192.168.0.1/",
		]) {
			expect(SmsGatewayUtils.isSecureUrl(url, true), url).toBe(true);
		}
	});

	it("refuse une adresse PUBLIQUE en clair meme avec l'exception", () => {
		// L'exception sert a tolerer un reseau qu'on maitrise, pas a envoyer
		// des donnees de membres en clair sur Internet.
		for (const url of [
			"http://8.8.8.8:8169",
			"http://172.15.0.1",   // juste sous la plage privee
			"http://172.32.0.1",   // juste au-dessus
			"http://193.168.1.38", // ressemble a 192.168 sans en etre
			"http://odoo.exemple.org",
		]) {
			expect(SmsGatewayUtils.isSecureUrl(url, true), url).toBe(false);
		}
	});

	it("le HTTPS n'a jamais besoin de l'exception", () => {
		expect(SmsGatewayUtils.isSecureUrl("https://odoo.exemple.org")).toBe(true);
	});

	it("le bouclage reste tolere sans exception", () => {
		expect(SmsGatewayUtils.isSecureUrl("http://127.0.0.1:8169")).toBe(true);
	});

	it("une URL de reseau local reste signalee comme derogation", () => {
		expect(SmsGatewayUtils.isDevelopmentUrl(LAN, true)).toBe(true);
	});
});
