/*
 * From pastel@4.0.1 (https://github.com/vadimdemedes/pastel at fe4ce10046a55d0492a35b1ae08f54b5c64775e4), index.ts.
 * Copyright (c) Vadym Demedes. MIT: see cli-kit/LICENSE.
 * Modified by Brenno Ferrari: the program parses with positional options and passes root options given before a subcommand on to it (ShardMind #147); no read of the package.json above the current directory (read-package-up).
 */

import {fileURLToPath} from 'node:url';
import process from 'node:process';
import {createProgram} from './lib/program.js';
import generateCommand from './generate-command.js';
import readCommands from './read-commands.js';
import generateCommands from './generate-commands.js';
import App from './_app.js';
import readCustomApp from './read-custom-app.js';
import type {CommandArgumentConfig, CommandOptionConfig} from './types.js';

export type Options = {
	/**
	 * Program name. Defaults to the name of the executable.
	 */
	name?: string;

	/**
	 * Version. No `--version` option without it.
	 */
	version?: string;

	/**
	 * Description, unless the index command describes itself.
	 */
	description?: string;

	/**
	 * Pass in [`import.meta`](https://nodejs.org/dist/latest/docs/api/esm.html#esm_import_meta). This is used to find the `commands` directory.
	 */
	importMeta: ImportMeta;
};

export default class Pastel {
	private readonly options: Options;

	constructor(options: Options) {
		this.options = options;
	}

	/**
	 * Run the app.
	 */
	async run(argv: string[] = process.argv) {
		const commandsDirectory = fileURLToPath(
			new URL('commands', this.options.importMeta.url),
		);

		const appComponent = (await readCustomApp(commandsDirectory)) ?? App;
		const program = createProgram();

		const commands = await readCommands(commandsDirectory);
		const indexCommand = commands.get('index');

		if (indexCommand) {
			generateCommand(program, indexCommand, {appComponent});
			commands.delete('index');
		}

		generateCommands(program, commands, {appComponent});

		if (this.options.name) {
			program.name(this.options.name);
		}

		const {version} = this.options;

		if (version) {
			program.version(version, '-v, --version', 'Show version number');
		}

		const description =
			indexCommand?.description ?? this.options.description ?? '';

		program.description(description);
		program.helpOption('-h, --help', 'Show help');
		program.parse(argv);
	}
}

/**
 * Set additional metadata for an option. Must be used as an argument to `describe` function from Zod.
 */
export function option(config: CommandOptionConfig) {
	return `__pastel_option_config__${JSON.stringify(config)}`;
}

/**
 * Set additional metadata for an argument. Must be used as an argument to `describe` function from Zod.
 */
export function argument(config: CommandArgumentConfig) {
	return `__pastel_argument_config__${JSON.stringify(config)}`;
}

export * from './types.js';
export {createProgram} from './lib/program.js';
