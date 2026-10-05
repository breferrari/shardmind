/*
 * From @inkjs/ui@2.0.0 (https://github.com/vadimdemedes/ink-ui at 14b1145da0123a48cfc2f0ec9ff33dff0633f464), components/status-message/status-message.tsx.
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: no default React import.
 */

import {type ReactNode} from 'react';
import {Box, Text} from 'ink';
import {useComponentTheme} from '../../theme.js';
import {type Theme} from './theme.js';
import {type StatusMessageVariant} from './types.js';

export type StatusMessageProps = {
	/**
	 * Message.
	 */
	readonly children: ReactNode;

	/**
	 * Variant, which determines the color used in the status message.
	 */
	readonly variant: StatusMessageVariant;
};

export function StatusMessage({children, variant}: StatusMessageProps) {
	const {styles, config} = useComponentTheme<Theme>('StatusMessage');

	return (
		<Box {...styles.container()}>
			<Box {...styles.iconContainer()}>
				<Text {...styles.icon({variant})}>{config({variant}).icon}</Text>
			</Box>

			<Text {...styles.message()}>{children}</Text>
		</Box>
	);
}
