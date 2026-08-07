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
	 * Seules les adresses NON ROUTABLES y échappent : bouclage, et `10.0.2.2`
	 * qui désigne la machine hôte vue depuis un émulateur. Elles ne quittent
	 * jamais la machine, donc la dérogation ne peut pas servir à exposer des
	 * données sur un réseau.
	 */
	public static isSecureUrl(url: string): boolean {
		const value = String(url ?? "").trim().toLowerCase();
		if (/^https:\/\/[^\s]+$/.test(value)) {
			return true;
		}
		return /^http:\/\/(10\.0\.2\.2|127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(value);
	}

	/** Vrai si l'URL passe par une dérogation de développement. */
	public static isDevelopmentUrl(url: string): boolean {
		return SmsGatewayUtils.isSecureUrl(url)
			&& !String(url ?? "").trim().toLowerCase().startsWith("https://");
	}
}
