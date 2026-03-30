export const StorageConstants: Record<string, string> = {
  APPLICATIONS_STORAGE_KEY: "applications",
	NOTES_STORAGE_KEY: "notes",
	BIOMETRY_ENABLED_STORAGE_KEY: "biometry_enabled",
	DB_ENCRYPTION_KEY: "db_encryption_key",
	SYNC_SESSION_PREFIX: "odoo_sync_session_",   // + base64(url+username)
	SYNC_CONFIG_KEY: "odoo_sync_config",
};
