import { Component, useState, xml } from "@odoo/owl";

import DeleteIcon from "../../../assets/icon/delete.svg";
import EditIcon from "../../../assets/icon/edit.svg";
import OpenIcon from "../../../assets/icon/open.svg";
import UserIcon from "../../../assets/icon/user.svg";

export class ApplicationsItemComponent extends Component {
	static template = xml`
    <li
      class="app-list__item"
    >
      <div class="app-list__item__data">
        <p class="app-list__item__url"><t t-esc="props.app.url"></t></p>
      </div>
      <div class="app-list__item__user">
        <img src="${UserIcon}" />
        <p class="app-list__item__username"><t t-esc="props.app.username"></t></p>
      </div>
      <div class="app-list__item__actions">
        <button
          type="button"
          class="app-list__item__action app-list__item__delete"
          t-on-click.stop="() => this.props.deleteApp(state.appID)"
        >
          <img src="${DeleteIcon}" />
        </button>
        <button
          type="button"
          class="app-list__item__action app-list__item__edit"
          t-on-click.stop="() => this.props.editApp(state.appID)"
        >
          <img src="${EditIcon}" />
        </button>
        <button
          type="button"
          class="app-list__item__action app-list__item__open"
          t-on-click.stop="() => this.props.openApp(state.appID)"
        >
          <img src="${OpenIcon}" />
        </button>
      </div>
    </li>
  `;

	state: any = undefined;

	setup() {
		this.state = useState({ appID: undefined });
		this.state.appID = {
			url: this.props.app.url,
			username: this.props.app.username
		};
	}
}
