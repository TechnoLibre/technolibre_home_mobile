import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
	},
	resolve: {
		alias: {
			"@capacitor-community/sqlite": "./src/__mocks__/@capacitor-community/sqlite.ts",
			"@capacitor/core": "./src/__mocks__/@capacitor/core.ts",
			"@odoo/owl": "./src/__mocks__/@odoo/owl.ts",
		},
	},
});
