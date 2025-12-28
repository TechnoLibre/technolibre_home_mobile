import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

export interface StorageGetResult<TValue = any> {
	keyExists: boolean;
	value?: TValue;
	isValid: boolean;
}

export class StorageUtils {
	public static async getValueByKey<TValue>(key: string): Promise<StorageGetResult<TValue>> {
		let resultKeyExists: boolean = false;
		let resultValue: TValue | undefined = undefined;

		try {
			const result = await SecureStoragePlugin.get({ key });
			resultKeyExists = true;
			resultValue = JSON.parse(result.value);
		} catch (error: unknown) {
			resultKeyExists = false;
			resultValue = undefined;
		} finally {
			const result: StorageGetResult<TValue> = {
				keyExists: resultKeyExists,
				value: resultValue,
				get isValid(): boolean {
					return this.keyExists && this.value !== undefined;
				}
			};
			return result;
		}
	}

	public static setKeyValuePair(key: string, value: any): Promise<{ value: boolean }> {
		return SecureStoragePlugin.set({ key, value: JSON.stringify(value) });
	}
}
