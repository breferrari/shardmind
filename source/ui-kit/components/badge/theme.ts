/*
 * From @inkjs/ui 2.0.0 (github.com/vadimdemedes/ink-ui, commit 14b1145),
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 */

import {type TextProps} from 'ink';
import {type ComponentTheme} from '../../theme.js';

const theme = {
	styles: {
		container: ({color}: Pick<TextProps, 'color'>): TextProps => ({
			backgroundColor: color,
		}),
		label: (): TextProps => ({
			color: 'black',
		}),
	},
} satisfies ComponentTheme;

export default theme;
export type Theme = typeof theme;
