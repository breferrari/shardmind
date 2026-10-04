import {isDeepStrictEqual} from 'node:util';
import {
	useReducer,
	type Reducer,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {type Option} from '../../types.js';
import OptionMap from '../../lib/option-map.js';

type State = {
	/**
	 * Map where key is option's value and value is option's index.
	 */
	optionMap: OptionMap;

	/**
	 * Number of visible options.
	 */
	visibleOptionCount: number;

	/**
	 * Value of the currently focused option.
	 */
	focusedValue: string | undefined;

	/**
	 * Index of the first visible option.
	 */
	visibleFromIndex: number;

	/**
	 * Index of the last visible option.
	 */
	visibleToIndex: number;

	/**
	 * Value of the selected option.
	 */
	value: string | undefined;

	/**
	 * How many times Enter selected an option. `onChange` fires when it
	 * changes (ShardMind fix).
	 */
	selections: number;
};

type Action =
	| FocusNextOptionAction
	| FocusPreviousOptionAction
	| SelectFocusedOptionAction
	| ResetAction;

type FocusNextOptionAction = {
	type: 'focus-next-option';
};

type FocusPreviousOptionAction = {
	type: 'focus-previous-option';
};

type SelectFocusedOptionAction = {
	type: 'select-focused-option';
};

type ResetAction = {
	type: 'reset';
	state: State;
};

const reducer: Reducer<State, Action> = (state, action) => {
	switch (action.type) {
		case 'focus-next-option': {
			if (!state.focusedValue) {
				return state;
			}

			const item = state.optionMap.get(state.focusedValue);

			if (!item) {
				return state;
			}

			// eslint-disable-next-line prefer-destructuring
			const next = item.next;

			if (!next) {
				return state;
			}

			const needsToScroll = next.index >= state.visibleToIndex;

			if (!needsToScroll) {
				return {
					...state,
					focusedValue: next.value,
				};
			}

			const nextVisibleToIndex = Math.min(
				state.optionMap.size,
				state.visibleToIndex + 1,
			);

			const nextVisibleFromIndex =
				nextVisibleToIndex - state.visibleOptionCount;

			return {
				...state,
				focusedValue: next.value,
				visibleFromIndex: nextVisibleFromIndex,
				visibleToIndex: nextVisibleToIndex,
			};
		}

		case 'focus-previous-option': {
			if (!state.focusedValue) {
				return state;
			}

			const item = state.optionMap.get(state.focusedValue);

			if (!item) {
				return state;
			}

			// eslint-disable-next-line prefer-destructuring
			const previous = item.previous;

			if (!previous) {
				return state;
			}

			const needsToScroll = previous.index <= state.visibleFromIndex;

			if (!needsToScroll) {
				return {
					...state,
					focusedValue: previous.value,
				};
			}

			const nextVisibleFromIndex = Math.max(0, state.visibleFromIndex - 1);

			const nextVisibleToIndex =
				nextVisibleFromIndex + state.visibleOptionCount;

			return {
				...state,
				focusedValue: previous.value,
				visibleFromIndex: nextVisibleFromIndex,
				visibleToIndex: nextVisibleToIndex,
			};
		}

		case 'select-focused-option': {
			return {
				...state,
				value: state.focusedValue,
				selections: state.selections + 1,
			};
		}

		case 'reset': {
			return action.state;
		}
	}
};

export type UseSelectStateProps = {
	/**
	 * Number of items to display.
	 *
	 * @default 5
	 */
	visibleOptionCount?: number;

	/**
	 * Options.
	 */
	options: Option[];

	/**
	 * Initially selected option's value.
	 */
	defaultValue?: string;

	/**
	 * Callback for selecting an option.
	 */
	onChange?: (value: string) => void;
};

export type SelectState = Pick<
	State,
	'focusedValue' | 'visibleFromIndex' | 'visibleToIndex' | 'value'
> & {
	/**
	 * Visible options.
	 */
	visibleOptions: Array<Option & {index: number}>;

	/**
	 * Focus next option and scroll the list down, if needed.
	 */
	focusNextOption: () => void;

	/**
	 * Focus previous option and scroll the list up, if needed.
	 */
	focusPreviousOption: () => void;

	/**
	 * Select currently focused option.
	 */
	selectFocusedOption: () => void;
};

const createDefaultState = ({
	visibleOptionCount: customVisibleOptionCount,
	defaultValue,
	options,
}: Pick<
	UseSelectStateProps,
	'visibleOptionCount' | 'defaultValue' | 'options'
>) => {
	const visibleOptionCount =
		typeof customVisibleOptionCount === 'number'
			? Math.min(customVisibleOptionCount, options.length)
			: options.length;

	const optionMap = new OptionMap(options);

	// Focus starts on the default and the window scrolls to show it
	// (ShardMind fix): upstream always focused the first option, so Enter
	// on an untouched prompt picked the first option, not the default.
	const focused =
		(defaultValue === undefined ? undefined : optionMap.get(defaultValue)) ??
		optionMap.first;
	const visibleFromIndex = Math.max(
		0,
		Math.min(focused?.index ?? 0, options.length - visibleOptionCount),
	);

	return {
		optionMap,
		visibleOptionCount,
		focusedValue: focused?.value,
		visibleFromIndex,
		visibleToIndex: visibleFromIndex + visibleOptionCount,
		value: defaultValue,
		selections: 0,
	};
};

export const useSelectState = ({
	visibleOptionCount = 5,
	options,
	defaultValue,
	onChange,
}: UseSelectStateProps) => {
	const [state, dispatch] = useReducer(
		reducer,
		{visibleOptionCount, defaultValue, options},
		createDefaultState,
	);

	const [lastOptions, setLastOptions] = useState(options);

	if (options !== lastOptions && !isDeepStrictEqual(options, lastOptions)) {
		dispatch({
			type: 'reset',
			state: createDefaultState({visibleOptionCount, defaultValue, options}),
		});

		setLastOptions(options);
	}

	const focusNextOption = useCallback(() => {
		dispatch({
			type: 'focus-next-option',
		});
	}, []);

	const focusPreviousOption = useCallback(() => {
		dispatch({
			type: 'focus-previous-option',
		});
	}, []);

	// onChange fires once per Enter (ShardMind fix). Upstream fired it from
	// an effect on `previousValue !== value`, which never fired for the
	// seeded default (ShardMind #103) and fired again on every parent
	// re-render with a new callback or options (vadimdemedes/ink-ui#26).
	// The value comes from the reducer, not this render's closure, so keys
	// that arrive in one burst with Enter (↓ ↓ Enter) select what they
	// focused.
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	useEffect(() => {
		if (state.selections > 0 && state.value !== undefined) {
			onChangeRef.current?.(state.value);
		}
	}, [state.selections]);

	const selectFocusedOption = useCallback(() => {
		dispatch({
			type: 'select-focused-option',
		});
	}, []);

	const visibleOptions = useMemo(() => {
		return options
			.map((option, index) => ({
				...option,
				index,
			}))
			.slice(state.visibleFromIndex, state.visibleToIndex);
	}, [options, state.visibleFromIndex, state.visibleToIndex]);

	return {
		focusedValue: state.focusedValue,
		visibleFromIndex: state.visibleFromIndex,
		visibleToIndex: state.visibleToIndex,
		value: state.value,
		visibleOptions,
		focusNextOption,
		focusPreviousOption,
		selectFocusedOption,
	};
};
