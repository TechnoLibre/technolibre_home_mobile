import { Component, useState, xml } from "@odoo/owl";

export class DatePickerComponent extends Component {
	static template = xml`
		<div id="date-picker-component">
			<h1>DatePicker</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
