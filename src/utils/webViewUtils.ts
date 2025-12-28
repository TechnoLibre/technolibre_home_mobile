import { Capacitor } from "@capacitor/core";
import { InAppBrowser, OpenWebViewOptions } from "@capgo/inappbrowser";

export class WebViewUtils {
	public static isMobile(): boolean {
		return Capacitor.getPlatform() !== "web";
	}

	public static clearCache(): Promise<any> {
		return InAppBrowser.clearCache();
	}

	public static async openWebViewDesktop(url: string, script?: string): Promise<void> {
		let newWindow = window.open(url);

		if (!newWindow) {
			return;
		}

		let windowDocument = newWindow.document;

		if (!script) {
			return;
		}

		let newScript = document.createElement("script");

		// TODO not working the injection, not secure
		newScript.innerHTML = `window.onload = (${script})();`;
		windowDocument.body.appendChild(newScript);

		// newWindow.onload = function () {
		//     this.eval(newScript);
		// };
		// TODO support InAppBrowser.executeScript(code)
	}

	public static openWebViewMobile(options: OpenWebViewOptions): Promise<any> {
		return InAppBrowser.openWebView(options);
	}
}
