import { Component, useState, xml } from "@odoo/owl";
import { SimpleRouter } from "../../../js/router";
import { NoteService } from "../../../js/noteService";
import { Note } from "../types";
import { Dialog } from "@capacitor/dialog";
import { ErrorMessages } from "../../../js/errors";

export class NoteComponent extends Component {
	static template = xml`
		<div id="note-component">
			<h1>Note</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({
			noteId: undefined,
			note: undefined
		});
		this.setParams();
		this.getNote();
	}

	private setParams() {
		const router: SimpleRouter = this.env.router;
		const params = router.getRouteParams(window.location.pathname);
		this.state.noteId = decodeURIComponent(params["id"]);
	}

	private async getNote() {
		const noteService: NoteService = this.env.noteService;
		let matchingNote: Note | undefined;

		try {
			matchingNote = await noteService.getMatch(this.state.noteId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!matchingNote) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_MATCH });
			return;
		}

		console.log(this.state.note);
		this.state.note = matchingNote;
		console.log(this.state.note);
	}
}
