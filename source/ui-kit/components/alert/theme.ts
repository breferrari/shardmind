/*
 * From @inkjs/ui 2.0.0 (github.com/vadimdemedes/ink-ui, commit 14b1145),
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: glyphs from lib/figures.ts; typed theme parameters.
 */

import {type BoxProps, type TextProps} from 'ink';
import {figures} from '../../lib/figures.js';
import {type ComponentTheme} from '../../theme.js';
import {type AlertProps} from './alert.js';

type AlertVariant = AlertProps['variant'];

const colorByVariant: Record<string, string> = {
	info: 'blue',
	success: 'green',
	error: 'red',
	warning: 'yellow',
};

const theme = {
	styles: {
		container: ({variant}: {variant: AlertVariant}): BoxProps => ({
			flexGrow: 1,
			borderStyle: 'round',
			borderColor: colorByVariant[variant],
			gap: 1,
			paddingX: 1,
		}),
		iconContainer: (): BoxProps => ({
			flexShrink: 0,
		}),
		icon: ({variant}: {variant: AlertVariant}): TextProps => ({
			color: colorByVariant[variant],
		}),
		content: (): BoxProps => ({
			flexShrink: 1,
			flexGrow: 1,
			minWidth: 0,
			flexDirection: 'column',
			gap: 1,
		}),
		title: (): TextProps => ({
			bold: true,
		}),
		message: (): TextProps => ({}),
	},
	config({variant}: {variant: AlertVariant}) {
		let icon: string | undefined;

		if (variant === 'info') {
			icon = figures.info;
		}

		if (variant === 'success') {
			icon = figures.tick;
		}

		if (variant === 'error') {
			icon = figures.cross;
		}

		if (variant === 'warning') {
			icon = figures.warning;
		}

		return {icon};
	},
} satisfies ComponentTheme;

export default theme;
export type Theme = typeof theme;
