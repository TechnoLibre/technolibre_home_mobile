import { BiometricAuth, CheckBiometryResult } from "@aparajita/capacitor-biometric-auth";
import { StorageConstants } from "../constants/storage";
import { StorageGetResult, StorageUtils } from "./storageUtils";
import { AlertOptions, Dialog } from "@capacitor/dialog";

export class BiometryUtils {
	/**
	 * Returns true only when the user has explicitly enabled biometry
	 * (BIOMETRY_ENABLED_STORAGE_KEY is stored and set to true).
	 */
	public static async isEnabledByUser(): Promise<boolean> {
		const result: StorageGetResult = await StorageUtils.getValueByKey<boolean>(
			StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY
		);
		return result.isValid && result.value === true;
	}

	/**
	 * Prompts for biometric authentication only when the user has enabled it
	 * AND the device supports it. Returns true if the app should proceed.
	 * Used to gate access to the SQLite encryption key at startup.
	 */
	public static async authenticateForDatabase(): Promise<boolean> {
		const enabled = await this.isEnabledByUser();
		if (!enabled) {
			return true;
		}

		const available = await this.isBiometryAvailable();
		if (!available) {
			return true;
		}

		return await this.authenticate({
			title: "Authentification requise",
			message: "Veuillez vous authentifier pour accéder à vos données.",
		});
	}


	public static async isBiometryAvailable(): Promise<boolean> {
		const checkBiometryResult: CheckBiometryResult = await BiometricAuth.checkBiometry();
		return checkBiometryResult.isAvailable;
	}

	public static async authenticateIfAvailable(): Promise<boolean> {
		const bIsBiometryAvailable: boolean = await this.isBiometryAvailable();

		if (!bIsBiometryAvailable) {
			return true;
		}

		const storageGetResult: StorageGetResult = await StorageUtils.getValueByKey<boolean>(
			StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY
		);

		if (storageGetResult.keyExists && !storageGetResult.value) {
			return true;
		}

		return await this.authenticate();
	}

	public static async authenticate(errorAlertOptions?: AlertOptions): Promise<boolean> {
		let isAuthSuccessful: boolean = false;

		try {
			await BiometricAuth.authenticate();
			isAuthSuccessful = true;
		} catch (error: unknown) {
			isAuthSuccessful = false;
			if (errorAlertOptions) {
				await Dialog.alert(errorAlertOptions);
			}
		} finally {
			return isAuthSuccessful;
		}
	}
}
