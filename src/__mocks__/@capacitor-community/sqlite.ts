export class SQLiteConnection {
	constructor(_plugin: any) {}
	async isSecretStored() { return { result: true }; }
	async setEncryptionSecret(_passphrase: string) {}
	async createConnection() { return new SQLiteDBConnection(); }
}

export class SQLiteDBConnection {
	private _tables: Record<string, any[]> = {};

	async open() {}
	async execute(_sql: string, _transaction?: boolean) {}

	async query(sql: string, params?: any[]) {
		return { values: [] };
	}

	async run(sql: string, params?: any[], _transaction?: boolean) {
		return { changes: { changes: 1 } };
	}

	async beginTransaction() {}
	async commitTransaction() {}
	async rollbackTransaction() {}
}

export const CapacitorSQLite = {};
