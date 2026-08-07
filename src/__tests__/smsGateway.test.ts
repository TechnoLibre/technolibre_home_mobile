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
