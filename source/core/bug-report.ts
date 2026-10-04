/**
 * The report link shown with an unexpected error (#225): a new-issue URL on
 * the shardmind tracker carrying the shardmind version and nothing else. No
 * part of the error travels in it, so no value, vault path or file content
 * can leave the machine through it; the user pastes what they choose.
 *
 * It is kept short on purpose: Ink wraps a line at the terminal width with
 * real line breaks, and a link broken across lines can be neither clicked nor
 * copied whole. At about 70 characters it fits an 80-column terminal.
 */

const NEW_ISSUE_URL = 'https://github.com/breferrari/shardmind/issues/new';

/** With no readable version, the bare new-issue URL. */
export function bugReportUrl(version: string | undefined): string {
  return version === undefined ? NEW_ISSUE_URL : `${NEW_ISSUE_URL}?${new URLSearchParams({ body: `shardmind ${version}` })}`;
}
