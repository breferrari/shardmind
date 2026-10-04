/*
 * From @inkjs/ui@2.0.0 (https://github.com/vadimdemedes/ink-ui at 14b1145da0123a48cfc2f0ec9ff33dff0633f464), components/text-input/theme.ts.
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 */

import {type TextProps} from 'ink';
import {type ComponentTheme} from '../../theme.js';

const theme = {
	styles: {
		value: (): TextProps => ({}),
	},
} satisfies ComponentTheme;

export default theme;
export type Theme = typeof theme;
