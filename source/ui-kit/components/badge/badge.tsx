/*
 * From @inkjs/ui 2.0.0 (github.com/vadimdemedes/ink-ui, commit 14b1145),
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
