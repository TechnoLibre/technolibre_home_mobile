import {useState, xml} from "@odoo/owl";

import {EnhancedComponent} from "../../js/enhancedComponent";
import {HeadingComponent} from "../heading/heading_component";
import {SmsGatewayPlugin} from "../../plugins/smsGatewayPlugin";

import "./phone_dialer_component.scss";

// Libellés déjà traduits, pas des clés : le composant de fil d'Ariane affiche
// ce qu'on lui donne. Et il ne répète pas le titre de la page, qui est juste
// en dessous.
const BREADCRUMBS = [{label: "Accueil", url: "/"}];

/** Les touches, dans l'ordre d'un clavier téléphonique. */
const TOUCHES: {chiffre: string; lettres: string}[] = [
	{chiffre: "1", lettres: ""},
	{chiffre: "2", lettres: "ABC"},
	{chiffre: "3", lettres: "DEF"},
	{chiffre: "4", lettres: "GHI"},
	{chiffre: "5", lettres: "JKL"},
	{chiffre: "6", lettres: "MNO"},
	{chiffre: "7", lettres: "PQRS"},
	{chiffre: "8", lettres: "TUV"},
	{chiffre: "9", lettres: "WXYZ"},
	{chiffre: "*", lettres: ""},
	{chiffre: "0", lettres: "+"},
	{chiffre: "#", lettres: ""},
];

interface DialerState {
	numero: string;
	erreur: string;
	envoi: boolean;
}

/**
 * Clavier de composition, disponible quand l'application tient le rôle de
 * composeur.
 *
 * L'appel part par le MÊME chemin que le clic-pour-appeler d'Odoo
 * (`SmsGatewayPlugin.placeCall`), donc il est tracé et remonté au serveur comme
 * les autres. Un second chemin de composition qui échapperait au journal
 * donnerait des appels invisibles côté Odoo — exactement ce que la passerelle
 * existe pour éviter.
 */
export class PhoneDialerComponent extends EnhancedComponent {
	static template = xml`
      <div class="phone-dialer">
        <HeadingComponent title="t('phone.title')" breadcrumbs="breadcrumbs"/>

        <div class="phone-dialer__display">
          <span class="phone-dialer__number" t-esc="state.numero || ''"/>
          <button t-if="state.numero" type="button"
                  class="phone-dialer__erase"
                  t-on-click="onEffacer"
                  t-att-aria-label="t('phone.erase')">⌫</button>
        </div>

        <p t-if="state.erreur" class="phone-dialer__error" t-esc="state.erreur"/>

        <div class="phone-dialer__keys">
          <t t-foreach="touches" t-as="touche" t-key="touche.chiffre">
            <button type="button" class="phone-dialer__key"
                    t-on-click="() => this.onTouche(touche.chiffre)">
              <span class="phone-dialer__digit" t-esc="touche.chiffre"/>
              <span t-if="touche.lettres" class="phone-dialer__letters"
                    t-esc="touche.lettres"/>
            </button>
          </t>
        </div>

        <button type="button" class="phone-dialer__call"
                t-att-disabled="!state.numero or state.envoi"
                t-on-click="onAppeler"
                t-esc="t('phone.call')"/>
      </div>
    `;

	static components = {HeadingComponent};

	state!: DialerState;

	get breadcrumbs() {
		return BREADCRUMBS;
	}

	get touches() {
		return TOUCHES;
	}

	setup() {
		this.state = useState<DialerState>({numero: "", erreur: "", envoi: false});
	}

	onTouche(chiffre: string) {
		// Appui long sur 0 pour « + » serait plus fidèle à un vrai clavier ;
		// ici on reste au plus simple tant que c'est une sonde.
		this.state.numero += chiffre;
		this.state.erreur = "";
	}

	onEffacer() {
		this.state.numero = this.state.numero.slice(0, -1);
	}

	async onAppeler() {
		if (!this.state.numero || this.state.envoi) {
			return;
		}
		this.state.envoi = true;
		this.state.erreur = "";
		try {
			await SmsGatewayPlugin.placeCall({number: this.state.numero});
			this.state.numero = "";
		} catch (error: unknown) {
			// On AFFICHE l'échec au lieu de le taire : un numéro composé qui ne
			// part pas, sans un mot, se traduit par « le téléphone est cassé ».
			this.state.erreur =
				error instanceof Error ? error.message : String(error);
		} finally {
			this.state.envoi = false;
		}
	}
}
