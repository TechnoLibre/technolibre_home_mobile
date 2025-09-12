import { Component, useState, xml } from "@odoo/owl";

import { HeadingComponent } from "../heading/heading_component";

export class NotesComponent extends Component {
	static template = xml`
		<div id="notes-component">
			<HeadingComponent title="'Notes'"/>
			<section id="notes">
				<h2>Notes Section</h2>
			</section>
		</div>
	`;

	static components = { HeadingComponent };

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
