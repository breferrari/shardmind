/*
 * From @inkjs/ui@2.0.0 (https://github.com/vadimdemedes/ink-ui at 14b1145da0123a48cfc2f0ec9ff33dff0633f464), components/select/select-option.tsx.
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: glyphs from lib/figures.ts instead of the figures package.
 */

import {type ReactNode} from 'react';
import {Box, Text} from 'ink';
import {figures} from '../../lib/figures.js';
import {useComponentTheme} from '../../theme.js';
import {type Theme} from './theme.js';

export type SelectOptionProps = {
	/**
	 * Determines if option is focused.
	 */
	readonly isFocused: boolean;

	/**
	 * Determines if option is selected.
	 */
	readonly isSelected: boolean;

	/**
	 * Option label.
	 */
	readonly children: ReactNode;
};

export function SelectOption({
	isFocused,
	isSelected,
	children,
}: SelectOptionProps) {
	const {styles} = useComponentTheme<Theme>('Select');

	return (
		<Box {...styles.option({isFocused})}>
			{isFocused && <Text {...styles.focusIndicator()}>{figures.pointer}</Text>}

			<Text {...styles.label({isFocused, isSelected})}>{children}</Text>

			{isSelected && (
				<Text {...styles.selectedIndicator()}>{figures.tick}</Text>
			)}
		</Box>
	);
}
