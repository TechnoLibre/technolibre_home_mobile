import { Component, useState, xml } from "@odoo/owl";

export class NoteEntryGeolocationComponent extends Component {
	static template = xml`
		<div id="note-entry-geolocation-component">
			<h1>NoteEntryGeolocation</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
