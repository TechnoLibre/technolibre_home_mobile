import { kebabCase, pascalCase, snakeCase } from "change-case";
import { mkdirp } from "mkdirp";
import { promises } from "fs";
import { dirname } from "path";

const FOLDER_COMPONENTS = "src/components";
const FOLDER_CSS = "src/css";

const red = "\x1b[31m";
const clear = "\x1b[0m";

const args = process.argv.slice(2);

async function addComponentTypeScriptFile(componentName, componentPath) {
	const fileName = `${process.cwd()}/${FOLDER_COMPONENTS}/${componentPath}/${snakeCase(componentName)}_component.ts`;

	// prettier-ignore
	const fileContent = `import { Component, useState, xml } from "@odoo/owl";\n\nexport class ${pascalCase(componentName)}Component extends Component {\n\tstatic template = xml\`\n\t\t<div id="${kebabCase(componentName)}-component">\n\t\t\t<h1>${pascalCase(componentName)}</h1>\n\t\t</div>\n\t\`;\n\n\tstatic components = {};\n\n\tstate: any = undefined;\n\n\tsetup() {\n\t\tthis.state = useState({});\n\t}\n}\n`;

	await mkdirp(dirname(fileName));
	return promises.writeFile(fileName, fileContent);
}

async function addComponentCSSFile(componentName, componentPath) {
	const fileName = `${process.cwd()}/${FOLDER_COMPONENTS}/${componentPath}/${snakeCase(componentName)}_component.scss`;
	const fileContent = `#${kebabCase(componentName)}-component {\n\t//\n}\n`;

	await mkdirp(dirname(fileName));
	return promises.writeFile(fileName, fileContent);
}

async function addCSSFileToImports(componentName, componentPath, defaultComponentPath, cssPath) {
	const fileName = `${process.cwd()}/${cssPath}/components.scss`;
	let lineToAppend;

	if (componentPath === defaultComponentPath) {
		lineToAppend = `@use \"../components/${snakeCase(componentName)}/${snakeCase(componentName)}_component.scss\";\n`;
	} else {
		lineToAppend = `@use \"../components/${componentPath}/${snakeCase(componentName)}_component.scss\";\n`;
	}

	return promises.appendFile(fileName, lineToAppend);
}

function isArgFalse(arg) {
	if (arg === undefined) {
		return undefined;
	}
	return arg.toLowerCase() === "false";
}

async function generateComponent() {
	if (args.length === 0) {
		console.log(`${red}Error: no arguments were specified.${clear}`);
		return;
	}

	const componentName = args[0];

	const defaultComponentPathname = snakeCase(componentName);
	const componentPathname = args?.[1] || defaultComponentPathname;

	const componentAddCSS = isArgFalse(args?.[2]) ? false : true;

	try {
		await addComponentTypeScriptFile(componentName, componentPathname);

		if (componentAddCSS) {
			await addComponentCSSFile(componentName, componentPathname);
			await addCSSFileToImports(componentName, componentPathname, defaultComponentPathname, FOLDER_CSS);
		}

		console.log(`Component ${pascalCase(componentName)}Component created successfully.`);
	} catch (error) {
		console.log(`${red}Error while trying to create ${pascalCase(componentName)}.${clear}`);
	}
}

generateComponent();
