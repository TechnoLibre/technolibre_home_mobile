import { Capacitor } from "@capacitor/core";
import { InAppBrowser, OpenWebViewOptions } from "@capgo/inappbrowser";

export class WebViewUtils {
	public static isMobile(): boolean {
		return Capacitor.getPlatform() !== "web";
	}

	public static clearCache(): Promise<any> {
		return InAppBrowser.clearCache();
	}

	/**
	 * Returns a JavaScript snippet that injects a persistent CSS rule to
	 * add bottom padding equal to the system navigation bar height.
	 * Prepend this to any preShowScript so Odoo content is never hidden
	 * behind the Android back/home button bar.
	 */
	public static safeAreaScript(): string {
		return `(function(){
try{
  var ID='__erplibre_safe_inset';
  var CSS='body{padding-bottom:max(env(safe-area-inset-bottom,0px),56px)!important}';
  function inj(){
    if(!document.getElementById(ID)){
      var s=document.createElement('style');
      s.id=ID;s.textContent=CSS;
      (document.head||document.documentElement).appendChild(s);
    }
  }
  inj();
  new MutationObserver(inj).observe(document.documentElement,{childList:true,subtree:true});
}catch(e){}
})();`;
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

		newScript.textContent = `window.onload = (${script})();`;
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
