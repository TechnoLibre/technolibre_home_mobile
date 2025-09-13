import { Component, useState, xml } from "@odoo/owl";
import { SimpleRouter } from "../../../js/router";
import { NoteService } from "../../../js/noteService";
import { Note } from "../types";
import { Dialog } from "@capacitor/dialog";
import { ErrorMessages } from "../../../js/errors";
import { HeadingComponent } from "../../heading/heading_component";

export class NoteComponent extends Component {
	static template = xml`
		<div id="note-component">
			<section id="note-editable">
				
			</section>
		</div>
	`;

	static components = { HeadingComponent };

	state: any = undefined;

	setup() {
		this.state = useState({
			noteId: undefined,
			note: undefined,
			newNote: false
		});
		this.setParams();
		this.getNote();
	}

	private setParams() {
		const router: SimpleRouter = this.env.router;
		const params = router.getRouteParams(window.location.pathname);

		if (params?.["id"]) {
			this.state.noteId = decodeURIComponent(params?.["id"]);
		} else {
			this.state.newNote = true;
		}
	}

	private async getNote() {
		if (this.state.newNote) {
			return;
		}

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
