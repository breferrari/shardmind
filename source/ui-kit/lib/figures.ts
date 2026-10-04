/*
 * Copyright (c) 2026 Brenno Ferrari. MIT.
 * The glyphs and the Unicode check follow figures and is-unicode-supported
 * (Sindre Sorhus, MIT: see ui-kit/LICENSE-sindresorhus).
 */

import process from 'node:process';

/**
 * The glyphs the components draw, from `figures` (MIT, Sindre Sorhus),
 * with its rule for when a terminal can show Unicode
 * (`is-unicode-supported`). Kept here so the module needs no dependency
 * beyond ink and react.
 */
function isUnicodeSupported(): boolean {
	if (process.platform !== 'win32') {
		return process.env['TERM'] !== 'linux';
	}

	return (
		Boolean(process.env['WT_SESSION']) ||
		Boolean(process.env['TERMINUS_SUBLIME']) ||
		process.env['ConEmuTask'] === '{cmd::Cmder}' ||
		process.env['TERM_PROGRAM'] === 'Terminus-Sublime' ||
		process.env['TERM_PROGRAM'] === 'vscode' ||
		process.env['TERM'] === 'xterm-256color' ||
		process.env['TERM'] === 'alacritty' ||
		process.env['TERM'] === 'rxvt-unicode' ||
		process.env['TERM'] === 'rxvt-unicode-256color' ||
		process.env['TERMINAL_EMULATOR'] === 'JetBrains-JediTerm'
	);
}

const unicode = isUnicodeSupported();

export const figures = {
	pointer: unicode ? '❯' : '>',
	tick: unicode ? '✔' : '√',
	cross: unicode ? '✘' : '×',
	warning: unicode ? '⚠' : '‼',
	info: unicode ? 'ℹ' : 'i',
	square: '█',
	squareLightShade: '░',
};
