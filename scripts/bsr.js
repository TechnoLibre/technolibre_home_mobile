import { spawn } from "child_process";

const args = process.argv.slice(2);

const validArgValues = ["web", "ios", "android"];

function buildSyncRun() {
	const platform = args[0] || validArgValues[0];

	if (!validArgValues.includes(platform)) {
		console.log(`Invalid platform: ${platform}`);
		return;
	}

	let command = "";

	switch (platform) {
		case "web":
			command = "npm run build && npm start";
			break;
		case "ios":
			command = "npm run build && npx cap sync && npx cap run ios";
			break;
		case "android":
			command = "npm run build && npx cap sync && npx cap run android";
			break;
		default:
			break;
	}

	spawn(command, {
		shell: true,
		stdio: "inherit",
	});
}

buildSyncRun();
