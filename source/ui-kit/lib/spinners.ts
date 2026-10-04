/*
 * Copyright (c) 2026 Brenno Ferrari. MIT.
 * Frames and interval from cli-spinners (Sindre Sorhus, MIT: see
 * ui-kit/LICENSE-sindresorhus).
 */

/**
 * The spinners `Spinner` can draw. Only `dots` for now: adding one is a
 * new key here, which widens `SpinnerName` without breaking a caller.
 */
export const spinners = {
	dots: {
		interval: 80,
		frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
	},
} satisfies Record<string, {interval: number; frames: string[]}>;

export type SpinnerName = keyof typeof spinners;
