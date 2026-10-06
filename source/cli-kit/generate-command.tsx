/*
 * From pastel@4.0.1 (https://github.com/vadimdemedes/pastel at fe4ce10046a55d0492a35b1ae08f54b5c64775e4), generate-command.tsx.
 * Copyright (c) Vadym Demedes. MIT: see cli-kit/LICENSE.
 * Modified by Brenno Ferrari: StatusMessage from the ui-kit instead of @inkjs/ui; the schemas' registration and validation from lib/command-input.ts, shared with parse.ts (ShardMind #302).
 */

import process from 'node:process';
import {type Command as CommanderCommand} from 'commander';
import {render} from 'ink';
import React, {type ComponentType} from 'react';
import {StatusMessage} from '../ui-kit/index.js';
import {type Command} from './internal-types.js';
import {addSchemas, parseCommandInput} from './lib/command-input.js';
import {type AppProps} from './types.js';

const generateCommand = (
	commanderCommand: CommanderCommand,
	pastelCommand: Command,
	{appComponent}: {appComponent: ComponentType<AppProps>},
) => {
	commanderCommand.helpOption('-h, --help', 'Show help');

	if (pastelCommand.description) {
		commanderCommand.description(pastelCommand.description);
	}

	if (pastelCommand.alias) {
		commanderCommand.alias(pastelCommand.alias);
	}

	const hasVariadicArgument = addSchemas(commanderCommand, pastelCommand);

	const {component} = pastelCommand;

	if (component) {
		commanderCommand.action((...input) => {
			// Remove the last argument, which is an instance of Commander command
			input.pop();

			const options = input.pop() as Record<string, unknown>;
			const result = parseCommandInput(options, input, pastelCommand, hasVariadicArgument);

			if (!result.ok) {
				render(<StatusMessage variant="error">{result.message}</StatusMessage>);

				// eslint-disable-next-line unicorn/no-process-exit
				process.exit(1);
			}

			render(
				React.createElement(appComponent, {
					Component: component,
					commandProps: {
						options: result.options,
						args: result.args,
					},
				}),
			);
		});
	}
};

export default generateCommand;
