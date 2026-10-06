/*
 * Copyright (c) 2026 Brenno Ferrari. MIT.
 */

import {type Command as CommanderCommand} from 'commander';
import {fromZodError} from 'zod-validation-error';
import generateOptions from '../generate-options.js';
import generateArguments from '../generate-arguments.js';
import {type CommandArguments, type CommandOptions} from '../internal-types.js';

/** A command's zod schemas, as its module exports them. */
export type CommandSchemas = {args?: CommandArguments; options?: CommandOptions};

/**
 * Register a command's options and arguments on its Commander command, from
 * its zod schemas (ShardMind #302: one place for the Pastel run and the
 * headless `--json` run). Returns whether an argument is variadic.
 */
export function addSchemas(command: CommanderCommand, schemas: CommandSchemas): boolean {
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

	return hasVariadicArgument;
}

/**
 * Validate what Commander parsed (its action's options and arguments) with
 * the schemas. A failure carries the message a run prints: the zod issue,
 * one of them.
 */
export function parseCommandInput(
	rawOptions: Record<string, unknown>,
	rawArguments: unknown[],
	schemas: CommandSchemas,
	hasVariadicArgument: boolean,
): {ok: true; options: Record<string, unknown>; args: unknown[]} | {ok: false; message: string} {
	let options: Record<string, unknown> = {};
	if (schemas.options) {
		const result = schemas.options.safeParse(rawOptions);
		if (!result.success) {
			return {ok: false, message: zodMessage(result.error)};
		}

		options = (result.data ?? {}) as Record<string, unknown>;
	}

	let args: unknown[] = [];
	if (schemas.args) {
		const result = schemas.args.safeParse(hasVariadicArgument ? rawArguments.flat() : rawArguments);
		if (!result.success) {
			return {ok: false, message: zodMessage(result.error)};
		}

		args = (result.data ?? []) as unknown[];
	}

	return {ok: true, options, args};
}

function zodMessage(error: Parameters<typeof fromZodError>[0]): string {
	return fromZodError(error, {maxIssuesInMessage: 1, prefix: '', prefixSeparator: ''}).message;
}
