/*
 * Copyright (c) 2026 Brenno Ferrari. MIT.
 * The regular rule of plur 5.1.0 (Sindre Sorhus, MIT: see
 * cli-kit/LICENSE-sindresorhus).
 */

/**
 * The plural of `word`, by plur's regular rule: Pastel used it to name the
 * value of a variadic option (`--file <files...>`). plur's table of
 * irregular plurals is not carried over: ShardMind declares no variadic
 * option, so `child` gives `childs` here where plur gave `children`.
 */
export default function plur(word: string): string {
	return `${word.replace(/(?:s|x|z|ch|sh)$/i, '$&e').replace(/([^aeiou])y$/i, '$1ie')}s`.replace(/i?e?s$/i, match => {
		const isTailLowerCase = word.slice(-1) === word.slice(-1).toLowerCase();
		return isTailLowerCase ? match.toLowerCase() : match.toUpperCase();
	});
}
