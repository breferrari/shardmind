/*
 * From @inkjs/ui 2.0.0 (github.com/vadimdemedes/ink-ui, commit 14b1145),
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: cut to Select and TextInput, with no deepmerge and no any.
 */

import {type ReactNode, createContext, useContext} from 'react';
import selectTheme from './components/select/theme.js';
import textInputTheme from './components/text-input/theme.js';

export type Theme = {
	components: Record<string, ComponentTheme>;
};

export type ComponentTheme = {
	styles?: Record<string, (props: never) => ComponentStyles>;
	config?: (props: never) => Record<string, unknown>;
};

export type ComponentStyles = Record<string, unknown>;

export const defaultTheme: Theme = {
	components: {
		Select: selectTheme,
		TextInput: textInputTheme,
	},
};

export const ThemeContext = createContext<Theme>(defaultTheme);

export type ThemeProviderProps = {
	readonly children: ReactNode;
	readonly theme: Theme;
};

export function ThemeProvider({children, theme}: ThemeProviderProps) {
	return (
		<ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
	);
}

export const useComponentTheme = <Theme extends ComponentTheme>(
	component: string,
): Theme => {
	const theme = useContext(ThemeContext);
	return theme.components[component] as Theme;
};
