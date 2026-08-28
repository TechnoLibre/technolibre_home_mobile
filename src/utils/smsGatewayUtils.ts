import type { SmsGatewayStatus } from "../plugins/smsGatewayPlugin";

/** Les trois seuls états qu'un écran d'alerte doit distinguer. */
export type SmsGatewayHealth = "off" | "error" | "ok";

/**
 * Limite d'Android, vérifiée dans les sources AOSP (`SmsUsageMonitor.java`,
 * `DEFAULT_SMS_MAX_COUNT = 30` sur `DEFAULT_SMS_CHECK_PERIOD = 60000`),
 * comptée en SEGMENTS et par nom de paquet.
 */
export const ANDROID_SEGMENT_LIMIT_PER_MINUTE = 30;

export class SmsGatewayUtils {
	/**
	 * État de santé de la passerelle.
	 *
	 * Une passerelle démarrée mais non abonnée, ou privée de sa permission
	 * d'envoi, est en PANNE et non « en service » : elle n'enverra rien. Les
	 * confondre serait afficher un voyant vert sur un canal mort — exactement le
	 * mode de défaillance qu'un canal d'urgence ne doit pas avoir.
	 */
	public static health(status: SmsGatewayStatus): SmsGatewayHealth {
		if (!status.enabled) {
			return "off";
		}
		if (!status.running || !status.connected || !status.hasSendPermission) {
			return "error";
		}
		return "ok";
	}

	/**
	 * Durée d'envoi estimée, en secondes, pour un nombre de segments donné.
	 *
	 * Sert à annoncer avant l'envoi qu'un groupe de quarante personnes prend
	 * plusieurs minutes — ce qui n'est pas intuitif, et qui double dès que le
	 * message contient un caractère hors alphabet GSM.
	 */
	public static estimateSeconds(totalSegments: number, segmentsPerMinute: number): number {
		const rate = segmentsPerMinute > 0 ? segmentsPerMinute : 1;
		return Math.ceil((Math.max(totalSegments, 0) / rate) * 60);
	}

	/** Un débit au-delà de la limite système ne peut pas être respecté. */
	public static isRateSane(segmentsPerMinute: number): boolean {
		return segmentsPerMinute > 0 && segmentsPerMinute <= ANDROID_SEGMENT_LIMIT_PER_MINUTE;
	}

	/** Champs sans lesquels la passerelle ne peut pas fonctionner. */
	public static missingConfigFields(form: {
		odooBaseUrl: string;
		hmacSecret: string;
		deviceId: string;
	}): string[] {
		const required: (keyof typeof form)[] = ["odooBaseUrl", "hmacSecret", "deviceId"];
		return required.filter((field) => !String(form[field] ?? "").trim());
	}

	/**
	 * Le HTTPS est exigé — le contenu des messages et les numéros de téléphone
	 * transitent par cette URL.
	 *
	 * Deux dérogations, de nature très différente.
	 *
	 * Les adresses NON ROUTABLES — bouclage, et `10.0.2.2` qui désigne l'hôte
	 * vu d'un émulateur — sont tolérées sans condition : elles ne quittent
	 * jamais l'appareil, donc rien ne peut fuir.
	 *
	 * Le réseau local en clair, lui, expose réellement : sur un Wi-Fi partagé,
	 * numéros et messages sont lisibles par les autres. Il exige donc un
	 * accord explicite (`allowPlainLan`), et se limite aux plages privées.
	 */
	public static isSecureUrl(url: string, allowPlainLan = false): boolean {
		const value = String(url ?? "").trim().toLowerCase();
		if (/^https:\/\/[^\s]+$/.test(value)) {
			return true;
		}
		if (/^http:\/\/(10\.0\.2\.2|127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(value)) {
			return true;
		}
		return allowPlainLan && SmsGatewayUtils.isPrivateLanUrl(value);
	}

	/**
	 * L'URL vise-t-elle une adresse privée RFC 1918 en clair ?
	 *
	 * Les trois plages, et rien d'autre. Une adresse publique en HTTP reste
	 * refusée même quand l'exception réseau local est active : il n'existe
	 * aucune raison légitime d'envoyer des numéros de membres en clair sur
	 * Internet, alors qu'il en existe une — provisoire — de le faire sur un
	 * réseau qu'on maîtrise.
	 */
	public static isPrivateLanUrl(url: string): boolean {
		const value = String(url ?? "").trim().toLowerCase();
		return /^http:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?(\/|$)/.test(
			value,
		);
	}

	/** Vrai si l'URL passe par une dérogation de développement. */
	public static isDevelopmentUrl(url: string, allowPlainLan = false): boolean {
		return SmsGatewayUtils.isSecureUrl(url, allowPlainLan)
			&& !String(url ?? "").trim().toLowerCase().startsWith("https://");
	}

	/**
	 * Taille lisible, en unités binaires.
	 *
	 * Les seuils de purge du journal sont exprimés en mébioctets — 10 Mo au
	 * déclenchement, 7 Mo à l'arrêt — donc on divise par 1024 et non par 1000,
	 * sans quoi l'écran afficherait 10,5 Mo au moment précis où le service
	 * considère avoir atteint 10.
	 */
	public static formatBytes(bytes: number): string {
		const value = Number(bytes);
		if (!Number.isFinite(value) || value < 0) {
			return "—";
		}
		if (value < 1024) {
			return `${Math.round(value)} o`;
		}
		const units = ["Kio", "Mio", "Gio"];
		let scaled = value / 1024;
		let unit = 0;
		while (scaled >= 1024 && unit < units.length - 1) {
			scaled /= 1024;
			unit += 1;
		}
		return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${units[unit]}`;
	}

	/**
	 * Part du seuil haut déjà consommée, entre 0 et 1.
	 *
	 * Sert à la jauge de l'écran. Bornée à 1 : la vérification n'ayant lieu
	 * qu'une insertion sur deux cents, le journal peut dépasser brièvement le
	 * seuil, et une jauge au-delà de son maximum donnerait à croire à une fuite.
	 */
	public static journalFill(usedBytes: number, highWaterBytes: number): number {
		const used = Number(usedBytes);
		const high = Number(highWaterBytes);
		if (!Number.isFinite(used) || !Number.isFinite(high) || high <= 0) {
			return 0;
		}
		return Math.min(1, Math.max(0, used / high));
	}
}
