/*
 * Copyright (c) 2026 Brenno Ferrari. MIT.
 */

import {Command, CommanderError} from 'commander';
import {fromZodError} from 'zod-validation-error';
import {type ZodError} from 'zod';
import generateOptions from './generate-options.js';
import generateArguments from './generate-arguments.js';
import {type CommandArguments, type CommandOptions} from './internal-types.js';

/**
 * A command's arguments parsed as a Pastel run parses them, without Ink
 * (ShardMind #302): the same Commander options and arguments built from the
 * same zod schemas, the same `safeParse`, the same message for a value the
 * schema rejects. For a command whose `--json` run must not mount Ink.
 *
 * Throws an `Error` whose message is the one the Pastel run prints: a
 * Commander error (an unknown option, a missing value or argument) or the
 * zod issue (`fromZodError`, one issue). `argv` is the arguments after the
 * command name.
 */
export function parseCommandArgv<A extends unknown[] = unknown[], O = Record<string, unknown>>(
	argv: readonly string[],
	schemas: {args?: CommandArguments; options?: CommandOptions},
): {args: A; options: O} {
	const command = new Command()
		.exitOverride()
		.configureOutput({writeOut() {}, writeErr() {}});

	if (schemas.options) {
		for (const option of generateOptions(schemas.options)) {
			command.addOption(option);
		}
	}

	let hasVariadicArgument = false;
	if (schemas.args) {
		for (const argument of generateArguments(schemas.args)) {
			if (argument.variadic) {
				hasVariadicArgument = true;
			}

			command.addArgument(argument);
		}
	}

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

	let options = {} as O;
	if (schemas.options) {
		const result = schemas.options.safeParse(rawOptions);
		if (!result.success) {
			throw new Error(zodMessage(result.error));
		}

		options = (result.data ?? {}) as O;
	}

	let args = [] as unknown as A;
	if (schemas.args) {
		const result = schemas.args.safeParse(hasVariadicArgument ? rawArguments.flat() : rawArguments);
		if (!result.success) {
			throw new Error(zodMessage(result.error));
		}

		args = (result.data ?? []) as A;
	}

	return {args, options};
}

function zodMessage(error: ZodError): string {
	return fromZodError(error, {maxIssuesInMessage: 1, prefix: '', prefixSeparator: ''}).message;
}
