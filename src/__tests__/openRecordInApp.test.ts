import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Dialog } from "@capacitor/dialog";
import { setHttpAllowed } from "../services/odoo/httpPolicy";

const web = vi.hoisted(() => ({
	isMobile: vi.fn(() => false),
	openWebViewDesktop: vi.fn(async (_url: string, _script?: string) => {}),
	openWebViewMobile: vi.fn(async (_options: any) => {}),
	safeAreaScript: vi.fn(() => ""),
}));
vi.mock("../utils/webViewUtils", () => ({ WebViewUtils: web }));

import { openRecordInApp, type RecordInApp } from "../utils/openRecordInApp";

function memoryStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => { data.set(k, v); },
		removeItem: (k: string) => { data.delete(k); },
	};
}

const record = (p: Partial<RecordInApp> = {}): RecordInApp => ({
	label: "Tâche démo", appUrl: "https://odoo.example.com", username: "alice", password: "pw-demo",
	model: "project.task", resId: 5, ...p,
});

describe("openRecordInApp", () => {
	beforeEach(() => {
		vi.stubGlobal("localStorage", memoryStorage());
		vi.mocked(Dialog.alert).mockClear();
		for (const f of Object.values(web)) f.mockClear();
	});
	afterEach(() => vi.unstubAllGlobals());

	it("opens the record's form, or the path given, with the login script", async () => {
		await openRecordInApp(record());
		expect(web.openWebViewDesktop.mock.calls[0][0]).toBe("https://odoo.example.com/web#id=5&model=project.task&view_type=form");
		await openRecordInApp(record({ appUrl: "odoo.example.com/", path: "/mail/message/605" }));
		const [url, script] = web.openWebViewDesktop.mock.calls[1];
		expect(url).toBe("https://odoo.example.com/mail/message/605");
		expect(script).toContain('"pw-demo"');
		web.isMobile.mockReturnValueOnce(true);
		await openRecordInApp(record({ path: "/mail/message/605" }));
		expect(web.openWebViewMobile.mock.calls[0][0]).toMatchObject({ url: "https://odoo.example.com/mail/message/605", title: "Tâche démo" });
	});

	it("an http server not allowed is refused before the web view", async () => {
		await openRecordInApp(record({ appUrl: "http://odoo.example.com", path: "/mail/message/605" }));
		expect(Dialog.alert).toHaveBeenCalledTimes(1);
		expect(web.openWebViewDesktop).not.toHaveBeenCalled();
		expect(web.openWebViewMobile).not.toHaveBeenCalled();
		setHttpAllowed(true);
		await openRecordInApp(record({ appUrl: "http://odoo.example.com", path: "/mail/message/605" }));
		expect(web.openWebViewDesktop.mock.calls[0][0]).toBe("http://odoo.example.com/mail/message/605");
	});
});
