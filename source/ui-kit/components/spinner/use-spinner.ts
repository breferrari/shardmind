/*
 * From @inkjs/ui 2.0.0 (github.com/vadimdemedes/ink-ui, commit 14b1145),
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: frames from lib/spinners.ts instead of cli-spinners.
 */

import {useEffect, useState} from 'react';
import {spinners, type SpinnerName} from '../../lib/spinners.js';

export type UseSpinnerProps = {
	/**
	 * Type of a spinner.
	 * See `lib/spinners.ts` for the available spinners.
	 *
	 * @default dots
	 */
	type?: SpinnerName;
};

export type UseSpinnerResult = {
	frame: string;
};

export function useSpinner({type = 'dots'}: UseSpinnerProps): UseSpinnerResult {
	const [frame, setFrame] = useState(0);
	const spinner = spinners[type];

	useEffect(() => {
		const timer = setInterval(() => {
			setFrame(previousFrame => {
				const isLastFrame = previousFrame === spinner.frames.length - 1;
				return isLastFrame ? 0 : previousFrame + 1;
			});
		}, spinner.interval);

		return () => {
			clearInterval(timer);
		};
	}, [spinner]);

	return {
		frame: spinner.frames[frame] ?? '',
	};
}
