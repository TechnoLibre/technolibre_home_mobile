import { HomeComponent } from "../components/home/home_component";
import { ApplicationsComponent } from "../components/applications/applications_component";
import { OptionsComponent } from "../components/options/options_component";
import { ApplicationsAddComponent } from "../components/applications/add/applications_add_component";
import { ApplicationsEditComponent } from "../components/applications/edit/applications_edit_component";

export interface Route {
	pathname: string;
	component: any;
}

export const routes: Route[] = [
	{ pathname: "/", component: HomeComponent },
	{ pathname: "/applications/edit/:url/:username", component: ApplicationsEditComponent },
	{ pathname: "/applications/add", component: ApplicationsAddComponent },
	{ pathname: "/applications", component: ApplicationsComponent },
	{ pathname: "/options", component: OptionsComponent },
	{ pathname: "*", component: HomeComponent }
];
