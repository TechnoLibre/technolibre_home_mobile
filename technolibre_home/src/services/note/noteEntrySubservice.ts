import { NoteEntry } from "../../models/note";
import { NoteService } from "./noteService";

export class NoteEntrySubservice {
  private _noteService: NoteService;

  constructor(newNoteService: NoteService) {
    this._noteService = newNoteService;
  }
  
  public getNewAudioEntry(): NoteEntry {
		return {
			id: this._noteService.getNewId(),
			type: "audio",
			params: {
				path: ""
			}
		}
	}

	public getNewDateEntry(): NoteEntry {
		return {
			id: this._noteService.getNewId(),
			type: "date",
			params: {
				date: ""
			}
		}
	}

	public getNewPhotoEntry(): NoteEntry {
		return {
			id: this._noteService.getNewId(),
			type: "photo",
			params: {
				path: ""
			}
		}
	}

	public getNewTextEntry(): NoteEntry {
		return {
			id: this._noteService.getNewId(),
			type: "text",
			params: {
				text: "",
				readonly: false
			}
		};
	}

	public getNewVideoEntry(): NoteEntry {
		return {
			id: this._noteService.getNewId(),
			type: "video",
			params: {
				path: ""
			}
		};
	}

	public getNewGeolocationEntry(): NoteEntry {
		return {
			id: this._noteService.getNewId(),
			type: "geolocation",
			params: {
				text: "",
				latitude: 0.0,
				longitude: 0.0,
				timestamp: 0
			}
		}
	}
}