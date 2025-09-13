import { Component, useState, xml } from "@odoo/owl";

export class NoteEntryAudioComponent extends Component {
	static template = xml`
		<div id="note-entry-audio-component">
			<h1>NoteEntryAudio</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
