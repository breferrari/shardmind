/*
 * From @inkjs/ui@2.0.0 (https://github.com/vadimdemedes/ink-ui at 14b1145da0123a48cfc2f0ec9ff33dff0633f464), components/badge/badge.tsx.
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: no default React import.
 */

import {Text, type TextProps} from 'ink';
import {type ReactNode} from 'react';
import {useComponentTheme} from '../../theme.js';
import {type Theme} from './theme.js';

export type BadgeProps = {
	/**
	 * Label.
	 */
	readonly children: ReactNode;

	/**
	 * Color.
	 *
	 * @default "magenta"
	 */
	readonly color?: TextProps['color'];
};

export function Badge({children, color = 'magenta'}: BadgeProps) {
	const {styles} = useComponentTheme<Theme>('Badge');

	let formattedChildren = children;

	if (typeof children === 'string') {
		formattedChildren = children.toUpperCase();
	}

	return (
		<Text {...styles.container({color})}>
			{' '}
			<Text {...styles.label()}>{formattedChildren}</Text>{' '}
		</Text>
	);
}
