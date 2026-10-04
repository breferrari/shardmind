/*
 * From @inkjs/ui 2.0.0 (github.com/vadimdemedes/ink-ui, commit 14b1145),
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 */

import {useInput} from 'ink';
import {type SelectState} from './use-select-state.js';

export type UseSelectProps = {
	/**
	 * When disabled, user input is ignored.
	 *
	 * @default false
	 */
	isDisabled?: boolean;

	/**
	 * Select state.
	 */
	state: SelectState;
};

export const useSelect = ({isDisabled = false, state}: UseSelectProps) => {
	useInput(
		(_input, key) => {
			if (key.downArrow) {
				state.focusNextOption();
			}

			if (key.upArrow) {
				state.focusPreviousOption();
			}

			if (key.return) {
				state.selectFocusedOption();
			}
		},
		{isActive: !isDisabled},
	);
};
