/*
 * From @inkjs/ui@2.0.0 (https://github.com/vadimdemedes/ink-ui at 14b1145da0123a48cfc2f0ec9ff33dff0633f464), components/spinner/theme.ts.
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 */

import {type BoxProps, type TextProps} from 'ink';
import {type ComponentTheme} from '../../theme.js';

const theme = {
	styles: {
		container: (): BoxProps => ({
			gap: 1,
		}),
		frame: (): TextProps => ({
			color: 'blue',
		}),
		label: (): TextProps => ({}),
	},
} satisfies ComponentTheme;

export default theme;
export type Theme = typeof theme;
