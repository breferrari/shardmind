/*
 * From @inkjs/ui@2.0.0 (https://github.com/vadimdemedes/ink-ui at 14b1145da0123a48cfc2f0ec9ff33dff0633f464), components/spinner/spinner.tsx.
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: no default React import.
 */

import {Box, Text} from 'ink';
import {useComponentTheme} from '../../theme.js';
import {useSpinner, type UseSpinnerProps} from './use-spinner.js';
import {type Theme} from './theme.js';

export type SpinnerProps = UseSpinnerProps & {
	/**
	 * Label to show near the spinner.
	 */
	readonly label?: string;
};

export function Spinner({label, type}: SpinnerProps) {
	const {frame} = useSpinner({type});
	const {styles} = useComponentTheme<Theme>('Spinner');

	return (
		<Box {...styles.container()}>
			<Text {...styles.frame()}>{frame}</Text>
			{label && <Text {...styles.label()}>{label}</Text>}
		</Box>
	);
}
