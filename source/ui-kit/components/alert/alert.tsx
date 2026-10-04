/*
 * From @inkjs/ui 2.0.0 (github.com/vadimdemedes/ink-ui, commit 14b1145),
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: no default React import.
 */

import {type ReactNode} from 'react';
import {Box, Text} from 'ink';
import {useComponentTheme} from '../../theme.js';
import {type Theme} from './theme.js';

export type AlertProps = {
	/**
	 * Message.
	 */
	readonly children: ReactNode;

	/**
	 * Variant, which determines the color of the alert.
	 */
	readonly variant: 'info' | 'success' | 'error' | 'warning';

	/**
	 * Title to show above the message.
	 */
	readonly title?: string;
};

export function Alert({children, variant, title}: AlertProps) {
	const {styles, config} = useComponentTheme<Theme>('Alert');

	return (
		<Box {...styles.container({variant})}>
			<Box {...styles.iconContainer()}>
				<Text {...styles.icon({variant})}>{config({variant}).icon}</Text>
			</Box>

			<Box {...styles.content()}>
				{title && <Text {...styles.title()}>{title}</Text>}
				<Text {...styles.message()}>{children}</Text>
			</Box>
		</Box>
	);
}
