import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { buildViewPath } from "../../utils/debugUtils";

export class HeadingComponent extends EnhancedComponent {
	static template = xml`
    <div class="heading-component">
      <div class="heading-component__main">
        <t t-if="props.breadcrumbs and props.breadcrumbs.length">
          <nav class="breadcrumb">
            <t t-foreach="props.breadcrumbs" t-as="crumb" t-key="crumb.url">
              <a href="#"
                 t-att-data-url="crumb.url"
                 t-on-click.stop.prevent="onBreadcrumbClick">
                <t t-esc="crumb.label"/>
              </a>
              <span class="breadcrumb__sep">›</span>
            </t>
            <span class="breadcrumb__current"><t t-esc="props.title"/></span>
          </nav>
        </t>
        <h1 class="page-heading">
          <t t-esc="props.title"/>
        </h1>
      </div>
      <div class="breadcrumb__options-wrap heading-component__options">
        <button
          type="button"
          class="breadcrumb__options-btn"
          title="Options"
          aria-label="Options"
          aria-haspopup="menu"
          t-att-aria-expanded="state.showOptionsMenu ? 'true' : 'false'"
          t-on-click.stop.prevent="toggleOptionsMenu"
        >⋮</button>
        <div
          t-if="state.showOptionsMenu"
          class="breadcrumb__options-menu"
          role="menu"
        >
          <button
            type="button"
            class="breadcrumb__options-item"
            role="menuitem"
            t-on-click.stop.prevent="onDebugClick"
          >🐛 Debug</button>
        </div>
      </div>
      <div
        t-if="state.debugDialog.visible"
        class="error-dialog-overlay"
        role="presentation"
        t-on-click.stop.prevent="closeDebugDialog"
      >
        <div class="error-dialog" role="dialog" aria-modal="true" t-on-click.stop="">
          <pre class="debug-dialog__message" t-esc="state.debugDialog.message"/>
          <div class="error-dialog__actions">
            <button type="button" class="error-dialog__btn error-dialog__btn--note" t-on-click.stop.prevent="createDebugNote">📝 Ajouter une note</button>
            <button type="button" class="error-dialog__btn error-dialog__btn--close" t-on-click.stop.prevent="closeDebugDialog">Fermer</button>
          </div>
        </div>
      </div>
    </div>
  `;

	setup() {
		this.state = useState({
			showOptionsMenu: false,
			debugDialog: { visible: false, message: "" },
		});
	}

	toggleOptionsMenu() {
		this.state.showOptionsMenu = !this.state.showOptionsMenu;
	}

	onDebugClick() {
		this.state.showOptionsMenu = false;
		const crumbs = (this.props.breadcrumbs as Array<{ label: string }> | undefined) ?? [];
		const title = this.props.title as string;
		const viewPath = buildViewPath(crumbs, title);
		this.state.debugDialog = {
			visible: true,
			message: [
				`Vue       : ${viewPath}`,
				`Route     : ${window.location.pathname}`,
			].join("\n"),
		};
	}

	closeDebugDialog() {
		this.state.debugDialog.visible = false;
	}

	async createDebugNote() {
		const message = this.state.debugDialog.message;
		this.state.debugDialog.visible = false;
		const note = this.noteService.getNewNote(this.noteService.getNewId());
		note.title = "Debug";
		const entry = this.noteService.entry.getNewTextEntry();
		(entry.params as { text: string }).text = message;
		note.entries = [entry];
		await this.noteService.crud.add(note);
		this.navigate(`/note/${encodeURIComponent(note.id)}`);
	}

	onBreadcrumbClick(event: MouseEvent) {
		const url = (event.currentTarget as HTMLElement).dataset.url;
		if (url) this.navigate(url);
	}

}

