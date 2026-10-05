/*
 * From @inkjs/ui@2.0.0 (https://github.com/vadimdemedes/ink-ui at 14b1145da0123a48cfc2f0ec9ff33dff0633f464), components/select/use-select.ts.
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: an Enter inside a run of plain keys selects too (ShardMind #317).
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
		(input, key) => {
			if (key.downArrow) {
				state.focusNextOption();
			}

			if (key.upArrow) {
				state.focusPreviousOption();
			}

			// An Enter inside a run of plain keys is not reported as `key.return`
			// (ShardMind fix, #317).
			if (key.return || /[\r\n]/.test(input)) {
				state.selectFocusedOption();
			}
		},
		{isActive: !isDisabled},
	);
};
