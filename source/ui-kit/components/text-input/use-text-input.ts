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

		let index = 0;
		const result: TextSegment[] = state.value.length > 0 ? [] : [cursor];

		for (const char of state.value) {
			result.push(index === state.cursorOffset ? {text: char, inverse: true} : {text: char});

			index++;
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
