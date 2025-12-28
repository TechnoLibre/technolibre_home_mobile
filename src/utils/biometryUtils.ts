import { BiometricAuth, CheckBiometryResult } from "@aparajita/capacitor-biometric-auth";
import { StorageConstants } from "../constants/storage";
import { StorageGetResult, StorageUtils } from "./storageUtils";
import { AlertOptions, Dialog } from "@capacitor/dialog";

export class BiometryUtils {
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
