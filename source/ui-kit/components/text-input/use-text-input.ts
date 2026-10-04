/*
 * From @inkjs/ui 2.0.0 (github.com/vadimdemedes/ink-ui, commit 14b1145),
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: cursor and placeholder as Ink Text segments instead of chalk strings.
 */

import {useMemo} from 'react';
import {useInput} from 'ink';
import {type TextInputState} from './use-text-input-state.js';

export type UseTextInputProps = {
	/**
	 * When disabled, user input is ignored.
	 *
	 * @default false
	 */
	isDisabled?: boolean;

	/**
	 * Text input state.
	 */
	state: TextInputState;

	/**
	 * Text to display when input is empty.
	 */
	placeholder?: string;
};

/** A run of text and how to draw it: `inverse` marks the cursor. */
export type TextSegment = {
	readonly text: string;
	readonly inverse?: boolean;
	readonly dim?: boolean;
};

export type UseTextInputResult = {
	/**
	 * Input value.
	 */
	inputValue: TextSegment[];
};

const cursor: TextSegment = {text: ' ', inverse: true};

export const useTextInput = ({
	isDisabled = false,
	state,
	placeholder = '',
}: UseTextInputProps): UseTextInputResult => {
	const renderedPlaceholder = useMemo((): TextSegment[] => {
		if (isDisabled) {
			return placeholder ? [{text: placeholder, dim: true}] : [];
		}

		return placeholder && placeholder.length > 0
			? [
					{text: placeholder[0]!, inverse: true},
					{text: placeholder.slice(1), dim: true},
				]
			: [cursor];
	}, [isDisabled, placeholder]);

	const renderedValue = useMemo((): TextSegment[] => {
		if (isDisabled) {
			return [{text: state.value}];
		}

		// Plain text before the cursor, the character under it, plain text
		// after: three segments, not one per character.
		const before = state.value.slice(0, state.cursorOffset);
		const codePoint = state.value.codePointAt(state.cursorOffset);
		const under = codePoint === undefined ? '' : String.fromCodePoint(codePoint);
		const after = state.value.slice(state.cursorOffset + under.length);
		const result: TextSegment[] = state.value.length > 0 ? [] : [cursor];

		if (before) {
			result.push({text: before});
		}

		if (under) {
			result.push({text: under, inverse: true});
		}

		if (after) {
			result.push({text: after});
		}

		if (state.suggestion) {
			if (state.cursorOffset === state.value.length) {
				result.push(
					{text: state.suggestion[0]!, inverse: true},
					{text: state.suggestion.slice(1), dim: true},
				);
			} else {
				result.push({text: state.suggestion, dim: true});
			}

			return result;
		}

		if (state.value.length > 0 && state.cursorOffset === state.value.length) {
			result.push(cursor);
		}

		return result;
	}, [isDisabled, state.value, state.cursorOffset, state.suggestion]);

	useInput(
		(input, key) => {
			if (
				key.upArrow ||
				key.downArrow ||
				(key.ctrl && input === 'c') ||
				key.tab ||
				(key.shift && key.tab)
			) {
				return;
			}

			if (key.return) {
				state.submit();
				return;
			}

			if (key.leftArrow) {
				state.moveCursorLeft();
			} else if (key.rightArrow) {
				state.moveCursorRight();
			} else if (key.backspace || key.delete) {
				state.delete();
			} else {
				state.insert(input);
			}
		},
		{isActive: !isDisabled},
	);

	return {
		inputValue: state.value.length > 0 ? renderedValue : renderedPlaceholder,
	};
};
