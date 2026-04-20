/**
 * Frontmatter validation for hook scripts. Given a file's content and
 * the shard schema, report which required frontmatter fields are
 * present, missing, or unexpected (per the matched note-type rule).
 *
 * Files without frontmatter return `valid: true` (no rule to match).
 */

import { parse as parseYaml } from 'yaml';
import type { FrontmatterValidationResult, ShardSchema, FrontmatterRule } from './types.js';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Validate the YAML frontmatter of a note against the shard's
 * frontmatter rules.
 *
 * Picks a rule by `path_match` glob against `filePath`; falls back to
 * the `global` rule's required fields. Returns the missing required
 * fields and any extra fields not covered by any rule.
 *
 * @param filePath The note's vault-relative path (used for `path_match`).
 * @param content The full file content including frontmatter.
 * @param schema The shard schema (typically from `loadSchema`).
 * @returns `{ valid, noteType, missing, extra }`.
 *
 * @example
 * ```ts
 * import fs from 'node:fs/promises';
 * import { loadSchema, validateFrontmatter } from 'shardmind/runtime';
 *
 * const schema = await loadSchema();
 * const content = await fs.readFile('brain/Goals.md', 'utf-8');
 * const { valid, missing } = validateFrontmatter('brain/Goals.md', content, schema);
 * if (!valid) console.warn(`Missing required fields: ${missing.join(', ')}`);
 * ```
 */
export function validateFrontmatter(
  filePath: string,
  content: string,
  schema: ShardSchema,
): FrontmatterValidationResult {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return { valid: true, noteType: null, missing: [], extra: [] };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(match[1]!) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      parsed = {};
    }
  } catch {
    return { valid: false, noteType: null, missing: [], extra: [] };
  }

  const presentKeys = Object.keys(parsed);

  // Find matching note type by path_match
  let noteType: string | null = null;
  let rule: FrontmatterRule | undefined;

  for (const [key, entry] of Object.entries(schema.frontmatter)) {
    if (key === 'global') continue;
    const fm: FrontmatterRule = Array.isArray(entry) ? { required: entry as string[] } : entry;
    if (fm.path_match && filePath.match(globToRegex(fm.path_match))) {
      noteType = key;
      rule = fm;
      break;
    }
  }

  // Collect required fields from matched rule + global
  const required = new Set<string>();
  if (rule?.required) {
    for (const field of rule.required) required.add(field);
  }
  const globalEntry = schema.frontmatter['global'];
  const globalRule: FrontmatterRule | undefined = globalEntry
    ? (Array.isArray(globalEntry) ? { required: globalEntry as string[] } : globalEntry)
    : undefined;
  if (globalRule?.required) {
    for (const field of globalRule.required) required.add(field);
  }

  const missing = [...required].filter(f => !presentKeys.includes(f));
  const extra = presentKeys.filter(f => !required.has(f));

  return {
    valid: missing.length === 0,
    noteType,
    missing,
    extra,
  };
}

/**
 * Shell-glob → regex. Matches shell semantics:
 *   - `**` crosses path segments (`.*`)
 *   - `*`  does not (`[^/]*`) — `brain/*.md` matches `brain/Index.md` but
 *     not `brain/sub/Index.md`, consistent with every shell and the
 *     frontmatter rules shard authors write.
 *   - `?`  matches a single non-separator character.
 *
 * `**` is handled by splitting on the literal sequence first, then
 * escaping + expanding `*` / `?` inside each segment, then joining with
 * `.*`. No sentinel tokens — that avoids the attack where user input
 * containing the sentinel would be misinterpreted.
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .split('**')
    .map(segment =>
      segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'),
    )
    .join('.*');
  return new RegExp(`^${escaped}$`);
}
