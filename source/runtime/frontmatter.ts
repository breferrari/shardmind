import { parse as parseYaml } from 'yaml';
import type { FrontmatterValidationResult, ShardSchema, FrontmatterRule } from './types.js';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

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

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
