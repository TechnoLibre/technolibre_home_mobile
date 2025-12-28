import {useState, xml} from "@odoo/owl";

import {Dialog} from "@capacitor/dialog";

import {BiometryUtils} from "../../../utils/biometryUtils";
import {EnhancedComponent} from "../../../js/enhancedComponent";
import {ErrorMessages} from "../../../constants/errorMessages";

import {HeadingComponent} from "../../heading/heading_component";

const ENV = {
    // @ts-ignore
    TITLE: import.meta.env.VITE_TITLE ?? "TITLE",
    // @ts-ignore
    BUTTON_LABEL: import.meta.env.VITE_BUTTON_LABEL ?? "Connexion",
    // @ts-ignore
    LOGO_KEY: import.meta.env.VITE_LOGO_KEY ?? "techno",
    // @ts-ignore
    WEBSITE_URL: import.meta.env.VITE_WEBSITE_URL ?? "https://erplibre.ca",
    // @ts-ignore
    DEBUG_DEV: import.meta.env.VITE_DEBUG_DEV === "true",
};

export class ApplicationsEditComponent extends EnhancedComponent {
    static template = xml`
<div id="applications-edit-component">
    <HeadingComponent title="'Modifier une application'"/>
    <form
            id="app-edit__form"
            t-on-submit.prevent="onAppEditFormSubmit"
    >
        <t t-if="state.debug">
            <p>Debug</p>
            <ul>
                <t t-foreach="Object.entries(state)" t-as="entry" t-key="entry[0]">
                    <li>
                        <strong>
                            <t t-esc="entry[0]"/>
                        </strong>:
                        <t t-esc="entry[1]"/>
                        <br/>
                        <t t-foreach="Object.entries(entry[1])" t-as="entry2" t-key="entry2[0]">
                            <u>
                                <strong>
                                    <t t-esc="entry2[0]"/>
                                </strong>:
                                <t t-esc="entry2[1]"/>
                                <br/>
                            </u>
                        </t>
                    </li>
                </t>
            </ul>
        </t>

        <div class="app-edit__form-group">
            <label for="app-edit__url">Adresse du site web</label>
            <input type="text" name="url" id="app-edit__url" autocomplete="off" autocapitalize="off"
                   placeholder="example.com" required="true" t-model="state.app.url"/>
        </div>
        <div class="app-edit__form-group">
            <label for="app-edit__username">Nom d'utilisateur</label>
            <input type="text" name="username" id="app-edit__username" autocomplete="off" autocapitalize="off"
                   placeholder="username" required="true" t-model="state.app.username"/>
        </div>
        <div class="app-edit__form-group">
            <label for="app-edit__ignore_password">Ignore password</label>
            <input type="checkbox" name="ignore_password" id="app-edit__ignore_password" autocomplete="off"
                   t-model="state.app.ignore_password"/>
        </div>
        <t t-if="!state.app.ignore_password">
            <div class="app-edit__form-group">
                <label for="app-edit__password">Mot de passe</label>
                <input type="password" name="password" id="app-edit__password" autocomplete="off" placeholder="password"
                       required="true" t-model="state.app.password"/>
            </div>
        </t>
        <div class="app-edit__form-group">
            <input type="submit" id="app-edit__submit" value="Modifier"/>
        </div>
    </form>
</div>
  `;

    static components = {HeadingComponent};

    setup() {
        this.state = useState({
            app: {
                url: "",
                username: "",
                password: "",
                ignore_password: true,
            },
            originalAppID: {
                url: "",
                username: "",
            },
        });

        this.setParams();

        this.state.debug = ENV.DEBUG_DEV;
    }

    async onAppEditFormSubmit(): Promise<void> {
        if (
            this.state.app.url === "" ||
            this.state.app.username === "" ||
            (this.state.app.ignore_password === false && this.state.app.password === "")
        ) {
            return;
        }

        const isBiometricAuthSuccessful: boolean = await BiometryUtils.authenticateIfAvailable();

        if (!isBiometricAuthSuccessful) {
            Dialog.alert({message: ErrorMessages.BIOMETRIC_AUTH});
            return;
        }

        let saveSucceeded: boolean = false;

        const ignore = this.state.app.ignore_password === true;

        try {
            saveSucceeded = await this.appService.edit(this.state.originalAppID, this.state.app, {
                ignorePassword: ignore,
            });
        } catch (error: unknown) {
            if (error instanceof Error) {
                Dialog.alert({message: error.message});
                return;
            }
        }

        if (!saveSucceeded) {
            Dialog.alert({message: ErrorMessages.APP_SAVE});
            return;
        }

        this.clearFormFields();
        window.history.back();
    }

    private setParams() {
        const params = this.router.getRouteParams(window.location.pathname, "/applications/edit/:url/:username");
        this.state.app.url = decodeURIComponent(params?.get("url") || "");
        this.state.app.username = decodeURIComponent(params?.get("username") || "");
        this.state.originalAppID.url = this.state.app.url;
        this.state.originalAppID.username = this.state.app.username;
    }

    private clearFormFields(): void {
        this.state.app.url = "";
        this.state.app.username = "";
        this.state.app.password = "";
    }
}
