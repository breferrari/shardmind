/*
 * Copyright (c) 2026 Brenno Ferrari. MIT.
 * The default path of decamelize 6.0.1 (Sindre Sorhus, MIT: see
 * cli-kit/LICENSE-sindresorhus).
 */

/**
 * `camelCase` to `camel<separator>case`: what Pastel used to name commands,
 * options and arguments. decamelize's `preserveConsecutiveUppercase` option
 * is not carried over; Pastel never passed it.
 */
export default function decamelize(text: string, {separator = '_'}: {separator?: string} = {}): string {
	if (text.length < 2) {
		return text.toLowerCase();
	}

	const replacement = `$1${separator}$2`;

	// `dataForUSACounties` → `data_For_USACounties`
	const decamelized = text.replace(/([\p{Lowercase_Letter}\d])(\p{Uppercase_Letter})/gu, replacement);

	// `my_URLstring` → `my_ur_lstring`
	return decamelized
		.replace(/(\p{Uppercase_Letter})(\p{Uppercase_Letter}\p{Lowercase_Letter}+)/gu, replacement)
		.toLowerCase();
}
