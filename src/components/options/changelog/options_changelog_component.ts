import { onWillStart, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { getCurrentLocale } from "../../../i18n";
import {
  formatReleases,
  latestVersion,
  parseChangelog,
} from "../../../utils/changelogUtils";

/**
 * Shows the app version and the recent changelog entries.
 *
 * Both come from CHANGELOG.md as copied into the bundle by
 * `bundleSourcePlugin` — the same file the repository publishes. This
 * component previously carried its own copy of both, which is why it went on
 * announcing 2026.03.18.01 for five months. There is nothing here to bump at
 * release time.
 */
export class OptionsChangelogComponent extends EnhancedComponent {
  static template = xml`
    <li id="changelog" class="options-list__item">
      <a href="#" role="button" t-att-aria-label="t('options.changelog')"
         t-on-click.stop.prevent="onChangelogClick">
        📋 <t t-esc="label"/>
      </a>
    </li>
  `;

  setup() {
    this.state = useState({ version: "", body: "" });
    onWillStart(() => this.load());
  }

  /** The bundle carries one changelog per language; pick the reader's. */
  private get bundleUrl(): string {
    return getCurrentLocale() === "fr"
      ? "/repo/CHANGELOG.fr.md"
      : "/repo/CHANGELOG.md";
  }

  /**
   * A missing bundle is not an error worth surfacing at boot — the menu entry
   * simply falls back to its plain label, and the dialog explains why.
   */
  async load(): Promise<void> {
    try {
      const res = await fetch(this.bundleUrl);
      if (!res.ok) return;
      const releases = parseChangelog(await res.text());
      this.state.version = latestVersion(releases) ?? "";
      this.state.body = formatReleases(releases);
    } catch {
      // Left as loaded-nothing; `label` and `onChangelogClick` cover it.
    }
  }

  get label(): string {
    return this.state.version
      ? this.t("options.changelog_version", { version: this.state.version })
      : this.t("options.changelog");
  }

  async onChangelogClick(): Promise<void> {
    await Dialog.alert({
      title: this.state.version
        ? this.t("dialog.title.changelog", { version: this.state.version })
        : this.t("options.changelog"),
      message: this.state.body || this.t("message.changelog_unavailable"),
    });
  }
}
