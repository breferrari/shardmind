/**
 * The report link shown with an unexpected error (#225): a new-issue URL on
 * the shardmind tracker carrying the version and at most the error's first
 * line. Nothing else leaves the machine through it: no values, no vault
 * paths, no file contents. The stack is printed locally, and the user decides
 * what to paste.
 */

const NEW_ISSUE_URL = 'https://github.com/breferrari/shardmind/issues/new';
const MAX_LINE = 120;

/**
 * The first line of `message`, with every quoted string and every path-like
 * token (one holding `/` or `\`, or starting with a drive letter) replaced by
 * `…`, capped at 120 characters.
 */
export function scrubFirstLine(message: string): string {
  const first = message.split(/\r?\n/, 1)[0] ?? '';
  const unquoted = first.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '…');
  const scrubbed = unquoted
    .split(/(\s+)/)
    .map((token) => (/[/\\]|^[A-Za-z]:/.test(token) ? '…' : token))
    .join('')
    .trim();
  return scrubbed.length > MAX_LINE ? `${scrubbed.slice(0, MAX_LINE - 1)}…` : scrubbed;
}

export function bugReportUrl(error: unknown, version: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  const params = new URLSearchParams({
    title: `Unexpected error: ${scrubFirstLine(message)}`,
    body: [
      `shardmind ${version ?? '(version unknown)'}`,
      '',
      'What I ran:',
      '',
      'The stack shardmind printed (paste it if you are happy to share it; remove anything private):',
      '',
    ].join('\n'),
  });
  return `${NEW_ISSUE_URL}?${params.toString()}`;
}
