/*
 * Copyright (c) 2026 Brenno Ferrari. MIT.
 */

import {Command} from 'commander';

/**
 * The root command every cli-kit program parses with (ShardMind #147).
 *
 * An option written after a subcommand name belongs to that subcommand.
 * Commander binds program-level options anywhere on the line by default, so
 * a root option silently shadowed a subcommand option of the same name, and
 * the subcommand saw its default. Positional options fix that: a flag a
 * subcommand does not declare is then Commander's `unknown option` error.
 *
 * A root option written before a subcommand (`shardmind --verbose adopt`)
 * would land on the root, which does not run when a subcommand does. It is
 * passed on to the subcommand when that declares the same option, and refused
 * when it does not.
 */
export function createProgram(): Command {
	return new Command()
		.enablePositionalOptions()
		.hook('preSubcommand', forwardRootOptionsToSubcommand);
}

/**
 * Pass the root options given before a subcommand on to it, or refuse them
 * all in one message. The subcommand's own flags are parsed afterwards, so
 * they still win.
 */
function forwardRootOptionsToSubcommand(root: Command, sub: Command): void {
	const refused: string[] = [];
	for (const option of root.options) {
		const key = option.attributeName();
		if (root.getOptionValueSource(key) !== 'cli') {
			continue;
		}

		if (sub.options.some(o => o.attributeName() === key)) {
			sub.setOptionValueWithSource(key, root.getOptionValue(key), 'cli');
		} else {
			refused.push(option.long ?? option.flags);
		}
	}

	if (refused.length > 0) {
		const one = refused.length === 1;
		root.error(
			`error: ${refused.map(flag => `'${flag}'`).join(', ')} ${one ? 'is an option' : 'are options'} of '${root.name()}' itself, and '${sub.name()}' does not take ${one ? 'it' : 'them'}.`,
			{code: 'shardmind.rootOptionBeforeSubcommand', exitCode: 1},
		);
	}
}
