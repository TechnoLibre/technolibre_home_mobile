import { Dialog } from "@capacitor/dialog";
import { WebViewUtils } from "./webViewUtils";
import { assertUrlAllowed } from "../services/odoo/httpPolicy";

/** A record of an Odoo application to show in the app's web view, and the login it opens with. */
export interface RecordInApp {
	label: string;
	appUrl: string;
	username: string;
	password: string;
	model: string;
	resId: number;
}

/**
 * Opens a record's form in the web view (in-app browser on mobile, a
 * window on desktop), with a script that fills and submits the login form
 * when the page asks for it. An http url the user did not allow is
 * refused with a dialog, as sync requests are: the script types the
 * password into the page.
 */
export async function openRecordInApp(app: RecordInApp): Promise<void> {
	const baseUrl = /^https?:\/\//i.test(app.appUrl) ? app.appUrl : "https://" + app.appUrl;
	// The login script types the password into the page: same rule as sync requests
	try {
		assertUrlAllowed(baseUrl);
	} catch (e: unknown) {
		await Dialog.alert({ message: e instanceof Error ? e.message : String(e) });
		return;
	}
	const taskUrl = `${baseUrl}/web#id=${app.resId}&model=${encodeURIComponent(app.model)}&view_type=form`;

	const username = app.username.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const password = app.password.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

	const loginScript = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function getElementByXPath(xpath) {
    return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue || null;
  }
  function waitForXPathWithObserver(xpath, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const found = getElementByXPath(xpath);
      if (found) return resolve(found);
      let settled = false;
      const obs = new MutationObserver(() => {
        const el = getElementByXPath(xpath);
        if (el) { settled = true; obs.disconnect(); resolve(el); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { if (!settled) { obs.disconnect(); reject(new Error('Timeout: ' + xpath)); } }, timeout);
    });
  }
  function setInputValue(el, value) {
    try {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (d && d.set) d.set.call(el, value); else el.value = value;
    } catch { el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const ERR_SEL = '.alert.alert-danger';
  async function hasErrAfter(ms) { await sleep(ms); return !!document.querySelector(ERR_SEL); }
  if (window.__autoLoginSubmitted) return;
  if (await hasErrAfter(400)) return;
  try {
    const SUBMIT = "//button[@type='submit' and (contains(normalize-space(.), 'Log in') or contains(normalize-space(.), 'Se connecter') or contains(normalize-space(.), 'Connexion'))]";
    const [userEl, passEl] = await Promise.all([
      waitForXPathWithObserver("//*[@id='login']"),
      waitForXPathWithObserver("//*[@id='password']")
    ]);
    setInputValue(userEl, "${username}");
    setInputValue(passEl, "${password}");
    await sleep(250);
    if (!!document.querySelector(ERR_SEL)) return;
    const btn = await waitForXPathWithObserver(SUBMIT, 5000).catch(() => null);
    if (!btn || !!document.querySelector(ERR_SEL)) return;
    window.__autoLoginSubmitted = true;
    btn.scrollIntoView({ block: 'center' });
    await new Promise(r => requestAnimationFrame(r));
    btn.click();
  } catch(e) { console.error('[loginScript]', e); }
})();`;

	if (WebViewUtils.isMobile()) {
		WebViewUtils.openWebViewMobile({
			url: taskUrl,
			title: app.label,
			isPresentAfterPageLoad: true,
			preShowScript: WebViewUtils.safeAreaScript() + "\n" + loginScript,
			enabledSafeBottomMargin: true,
			toolbarColor: "#1a1a1a",
			toolbarTextColor: "#ffffff",
			activeNativeNavigationForWebview: true,
		});
	} else {
		WebViewUtils.openWebViewDesktop(taskUrl, loginScript);
	}
}
