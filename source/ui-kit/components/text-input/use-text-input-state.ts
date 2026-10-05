/*
 * From @inkjs/ui@2.0.0 (https://github.com/vadimdemedes/ink-ui at 14b1145da0123a48cfc2f0ec9ff33dff0633f464), components/text-input/use-text-input-state.ts.
 * Copyright (c) Vadym Demedes. MIT: see ui-kit/LICENSE.
 * Modified by Brenno Ferrari: onChange fires once per change of the text (vadimdemedes/ink-ui#26); onSubmit fires from the reducer's value, so text in the same input chunk as Enter counts (ShardMind #317); dead previousValue removed.
 */

import {useReducer, useCallback, useEffect, useRef, type Reducer, useMemo} from 'react';

type State = {
	value: string;
	cursorOffset: number;
	/** How many times Enter submitted; `onSubmit` fires when it changes (ShardMind fix). */
	submissions: number;
};

type Action =
	| MoveCursorLeftAction
	| MoveCursorRightAction
	| InsertAction
	| DeleteAction
	| SubmitAction;

type MoveCursorLeftAction = {
	type: 'move-cursor-left';
};

type MoveCursorRightAction = {
	type: 'move-cursor-right';
};

type InsertAction = {
	type: 'insert';
	text: string;
};

type DeleteAction = {
	type: 'delete';
};

type SubmitAction = {
	type: 'submit';
};

const reducer: Reducer<State, Action> = (state, action) => {
	switch (action.type) {
		case 'move-cursor-left': {
			return {
				...state,
				cursorOffset: Math.max(0, state.cursorOffset - 1),
			};
		}

		case 'move-cursor-right': {
			return {
				...state,
				cursorOffset: Math.min(state.value.length, state.cursorOffset + 1),
			};
		}

		case 'insert': {
			return {
				...state,
				value:
					state.value.slice(0, state.cursorOffset) +
					action.text +
					state.value.slice(state.cursorOffset),
				cursorOffset: state.cursorOffset + action.text.length,
			};
		}

		case 'delete': {
			const newCursorOffset = Math.max(0, state.cursorOffset - 1);

			return {
				...state,
				value:
					state.value.slice(0, newCursorOffset) +
					state.value.slice(newCursorOffset + 1),
				cursorOffset: newCursorOffset,
			};
		}

		case 'submit': {
			return {...state, submissions: state.submissions + 1};
		}
	}
};

export type UseTextInputStateProps = {
	/**
	 * Default input value.
	 */
	defaultValue?: string;

	/**
	 * Suggestions to autocomplete the input value.
	 */
	suggestions?: string[];

	/**
	 * Callback when input value changes.
	 */
	onChange?: (value: string) => void;

	/**
	 * Callback when enter is pressed. First argument is input value.
	 */
	onSubmit?: (value: string) => void;
};

export type TextInputState = State & {
	/**
	 * Suggested auto completion.
	 */
	suggestion: string | undefined;

	/**
	 * Move cursor to the left.
	 */
	moveCursorLeft: () => void;

	/**
	 * Move cursor to the right.
	 */
	moveCursorRight: () => void;

	/**
	 * Insert text.
	 */
	insert: (text: string) => void;

	/**
	 * Delete character.
	 */
	delete: () => void;

	/**
	 * Submit input value.
	 */
	submit: () => void;
};

export const useTextInputState = ({
	defaultValue = '',
	suggestions,
	onChange,
	onSubmit,
}: UseTextInputStateProps) => {
	const [state, dispatch] = useReducer(reducer, {
		value: defaultValue,
		cursorOffset: defaultValue.length,
		submissions: 0,
	});

	const suggestion = useMemo(() => {
		if (state.value.length === 0) {
			return;
		}

		return suggestions
			?.find(suggestion => suggestion.startsWith(state.value))
			?.replace(state.value, '');
	}, [state.value, suggestions]);

	const moveCursorLeft = useCallback(() => {
		dispatch({
			type: 'move-cursor-left',
		});
	}, []);

	const moveCursorRight = useCallback(() => {
		dispatch({
			type: 'move-cursor-right',
		});
	}, []);

	const insert = useCallback((text: string) => {
		dispatch({
			type: 'insert',
			text,
		});
	}, []);

	const deleteCharacter = useCallback(() => {
		dispatch({
			type: 'delete',
		});
	}, []);

	// onSubmit fires from the reducer's value, not this render's closure
	// (ShardMind fix, #317): text typed or pasted in the same input chunk as
	// Enter reaches the reducer before React re-renders, so the closure's
	// value would be the one from before it.
	const submit = useCallback(() => {
		dispatch({type: 'submit'});
	}, []);

	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;
	useEffect(() => {
		if (state.submissions === 0) {
			return;
		}

		if (suggestion) {
			insert(suggestion);
			onSubmitRef.current?.(state.value + suggestion);
			return;
		}

		onSubmitRef.current?.(state.value);
		// Only a new submission fires; a value or suggestion change does not.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state.submissions]);

	// Notify once per change of the text (ShardMind fix, the approach of
	// vadimdemedes/ink-ui#27). Upstream compared `previousValue !== value`,
	// which stays true after an edit, so every parent re-render with a new
	// callback fired onChange again (vadimdemedes/ink-ui#26).
	const lastNotifiedValue = useRef(state.value);
	useEffect(() => {
		if (state.value === lastNotifiedValue.current || !onChange) {
			return;
		}

		lastNotifiedValue.current = state.value;
		onChange(state.value);
	}, [state.value, onChange]);

	return {
		...state,
		suggestion,
		moveCursorLeft,
		moveCursorRight,
		insert,
		delete: deleteCharacter,
		submit,
	};
};
