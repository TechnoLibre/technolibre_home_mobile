import { HomeComponent } from "../components/home/home_component";
import { ApplicationsComponent } from "../components/applications/applications_component";
import { OptionsComponent } from "../components/options/options_component";
import { ApplicationsAddComponent } from "../components/applications/add/applications_add_component";
import { ApplicationsEditComponent } from "../components/applications/edit/applications_edit_component";
import { NotesComponent } from "../components/notes/notes_component";
import { NoteComponent } from "../components/notes/note/note_component";

export interface Route {
	pathname: string;
	component: any;
}

export const routes: Route[] = [
	{ pathname: "/", component: HomeComponent },
	{ pathname: "/applications/edit/:url/:username", component: ApplicationsEditComponent },
	{ pathname: "/applications/add", component: ApplicationsAddComponent },
	{ pathname: "/applications", component: ApplicationsComponent },
	{ pathname: "/notes", component: NotesComponent },
	{ pathname: "/notes/edit/:id", component: NotesComponent },
	{ pathname: "/note/new", component: NoteComponent },
	{ pathname: "/note/:id", component: NoteComponent },
	{ pathname: "/options", component: OptionsComponent },
	{ pathname: "*", component: HomeComponent }
];
