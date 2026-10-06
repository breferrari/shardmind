/*
 * Copyright (c) 2026 Brenno Ferrari. MIT.
 */

import {Command, CommanderError} from 'commander';
import {addSchemas, parseCommandInput, type CommandSchemas} from './lib/command-input.js';

/**
 * A command's arguments parsed as a Pastel run parses them, without Ink
 * (ShardMind #302): the same registration of its zod schemas on Commander
 * and the same validation (`lib/command-input.ts`, which `generate-command`
 * uses too), for a command whose `--json` run must not mount Ink.
 *
 * Throws an `Error` whose message is the one the Pastel run prints: a
 * Commander error (an unknown option, a missing value or argument) or the
 * zod issue. `argv` is the arguments after the command name.
 */
export function parseCommandArgv<A extends unknown[] = unknown[], O = Record<string, unknown>>(
	argv: readonly string[],
	schemas: CommandSchemas,
): {args: A; options: O} {
	const command = new Command()
		.exitOverride()
		.configureOutput({writeOut() {}, writeErr() {}});
	const hasVariadicArgument = addSchemas(command, schemas);

	let rawOptions: Record<string, unknown> = {};
	let rawArguments: unknown[] = [];
	command.action((...input: unknown[]) => {
		input.pop();
		rawOptions = input.pop() as Record<string, unknown>;
		rawArguments = input;
	});

	try {
		command.parse([...argv], {from: 'user'});
	} catch (error) {
		if (error instanceof CommanderError) {
			throw new Error(error.message);
		}

		throw error;
	}

	const result = parseCommandInput(rawOptions, rawArguments, schemas, hasVariadicArgument);
	if (!result.ok) {
		throw new Error(result.message);
	}

	return {args: result.args as A, options: result.options as O};
}
