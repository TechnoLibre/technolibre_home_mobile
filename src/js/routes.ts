import { HomeComponent } from "../components/home/home_component";
import { ApplicationsComponent } from "../components/applications/applications_component";
import { OptionsComponent } from "../components/options/options_component";
import { OptionsDatabaseComponent } from "../components/options/database/options_database_component";
import { ApplicationsAddComponent } from "../components/applications/add/applications_add_component";
import { ApplicationsEditComponent } from "../components/applications/edit/applications_edit_component";
import { IntentComponent } from "../components/intent/intent_component";
import { NoteListComponent } from "../components/note_list/note_list_component";
import { NoteComponent } from "../components/note/note_component";
import { ServersAddComponent } from "../components/servers/add/servers_add_component";
import { ServersEditComponent } from "../components/servers/edit/servers_edit_component";
import { ServersDeployComponent } from "../components/servers/deploy/servers_deploy_component";
import { ServersSettingsComponent } from "../components/servers/settings/servers_settings_component";
import { ServersWorkspaceComponent } from "../components/servers/workspace/servers_workspace_component";

export interface Route {
	pathname: string;
	component: any;
}

export const routes: Route[] = [
	{ pathname: "/", component: HomeComponent },
	{ pathname: "/applications/edit/:url/:username", component: ApplicationsEditComponent },
	{ pathname: "/applications/add", component: ApplicationsAddComponent },
	{ pathname: "/applications", component: ApplicationsComponent },
	{ pathname: "/servers/edit/:host/:username", component: ServersEditComponent },
	{ pathname: "/servers/add", component: ServersAddComponent },
	{ pathname: "/servers/settings/:host/:username", component: ServersSettingsComponent },
	{ pathname: "/servers/workspace/:host/:username", component: ServersWorkspaceComponent },
	{ pathname: "/servers/deploy/:host/:username", component: ServersDeployComponent },
	{ pathname: "/notes", component: NoteListComponent },
	{ pathname: "/notes/edit/:id", component: NoteListComponent },
	{ pathname: "/note/:id", component: NoteComponent },
	{ pathname: "/intent/:type", component: IntentComponent },
	{ pathname: "/options/database", component: OptionsDatabaseComponent },
	{ pathname: "/options", component: OptionsComponent },
	{ pathname: "*", component: HomeComponent }
];
