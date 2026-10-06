import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { stripNjk } from './modules.js';
import { foldOutputPath } from './fs-utils.js';
import nunjucks from 'nunjucks';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  FileEntry,
  RenderedFile,
  RenderContext,
  ShardManifest,
  ModuleSelections,
} from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';

const VOLATILE_MARKER = '{# shardmind: volatile #}';
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

const NUNJUCKS_OPTS = {
  autoescape: false,
  trimBlocks: true,
  lstripBlocks: true,
} as const;

/**
 * `keep` (validate in a git work tree, #320): a template includes only the
 * files it holds true for, so an include of an uncommitted or ignored partial
 * fails as it would from the release tarball.
 */
export function createRenderer(templateDir: string, keep?: (relPath: string) => boolean): nunjucks.Environment {
  if (!keep) return nunjucks.configure(templateDir, NUNJUCKS_OPTS);
  const root = path.resolve(templateDir);
  const kept = keep;
  // A loader with no search path finds nothing: its miss is nunjucks' own
  // (null at runtime, though the types never say so), so `ignore missing`
  // renders an untracked partial as empty, as the release would.
  const nowhere = new nunjucks.FileSystemLoader([]);
  class KeptLoader extends nunjucks.FileSystemLoader {
    override getSource(name: string): nunjucks.LoaderSource {
      const rel = path.relative(root, path.resolve(root, name)).split(path.sep).join('/');
      return kept(rel) ? super.getSource(name) : nowhere.getSource(name);
    }
  }
  return new nunjucks.Environment(new KeptLoader(templateDir), NUNJUCKS_OPTS);
}

/**
 * Isolated env for rendering a template from a string (no filesystem loader).
 * Lazily constructed so the `nunjucks.Environment` is only built when needed
 * and never pollutes the module's global `nunjucks.configure()` state.
 */
let defaultStringEnv: nunjucks.Environment | undefined;

function getDefaultStringEnv(): nunjucks.Environment {
  if (!defaultStringEnv) {
    // Empty loader array → no filesystem resolution. `{% include %}` et al.
    // wouldn't find anything, which is the correct behavior for in-memory
    // string rendering. (Passing `null` here works today but isn't
    // documented by nunjucks as a supported loader value.)
    defaultStringEnv = new nunjucks.Environment([], NUNJUCKS_OPTS);
  }
  return defaultStringEnv;
}

/**
 * Render a template provided as a string, with the same frontmatter-aware
 * split/render/YAML-normalize/recombine pipeline that `renderFile` uses.
 * Used by the merge engine (`differ.ts`) where the old/new templates live
 * in memory (cached or freshly downloaded), not on disk.
 */
export function renderString(
  source: string,
  context: RenderContext,
  filePath: string,
  env: nunjucks.Environment = getDefaultStringEnv(),
): string {
  return renderContent(source, context, env, filePath);
}

/**
 * Slugify a directory name into something safe to use as an identifier:
 * lowercase, non-alphanumerics collapsed to single hyphens, trimmed, and
 * guaranteed to start with an alphanumeric. Returns '' for input that has no
 * usable characters, so callers can fall back rather than emit a broken value.
 */
export function slugifyVaultName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+|[-._]+$/g, '');
  return slug;
}

/**
 * Build the Nunjucks render context for an install or update operation.
 * Centralizes the shape so the two commands can't drift apart on what's
 * available to templates.
 *
 * `vaultRoot` is optional and supplies `vault_name` / `vault_slug` — the only
 * per-install identity a template can reach, since `shard.name` is identical
 * for every install of the same shard (#137). Omitted, both are ''.
 */
export function buildRenderContext(
  manifest: ShardManifest,
  values: Record<string, unknown>,
  selections: ModuleSelections,
  now: Date = new Date(),
  vaultRoot?: string,
): RenderContext {
  const vaultName = vaultRoot === undefined ? '' : path.basename(path.resolve(vaultRoot));

  const included_modules = Object.entries(selections)
    .filter(([, s]) => s === 'included')
    .map(([id]) => id);

  return {
    values,
    included_modules,
    shard: { name: manifest.name, version: manifest.version },
    install_date: now.toISOString(),
    year: now.getUTCFullYear().toString(),
    vault_name: vaultName,
    vault_slug: slugifyVaultName(vaultName),
  };
}

export async function renderFile(
  entry: FileEntry,
  context: RenderContext,
  env: nunjucks.Environment,
): Promise<RenderedFile | RenderedFile[]> {
  const source = await fs.readFile(entry.sourcePath, 'utf-8');

  // Strip volatile marker from content before rendering
  const hasVolatileMarker = source.trimStart().startsWith(VOLATILE_MARKER);
  const cleanSource = hasVolatileMarker
    ? source.trimStart().slice(VOLATILE_MARKER.length).replace(/^\r?\n/, '')
    : source;

  const isVolatile = entry.volatile || hasVolatileMarker;

  // _each iterator handling
  if (entry.iterator) {
    return renderEach(entry, cleanSource, context, env, isVolatile);
  }

  const content = renderContent(cleanSource, context, env, entry.outputPath);
  return buildRenderedFile(entry.outputPath, content, isVolatile);
}

/**
 * Compile a template without rendering it, so a syntax error is found even
 * when there is nothing to render with: an `_each` template over an empty
 * list renders no file at all (#35).
 */
export async function compileTemplate(entry: FileEntry, env: nunjucks.Environment): Promise<void> {
  const source = await fs.readFile(entry.sourcePath, 'utf-8');
  try {
    new nunjucks.Template(source, env, entry.sourcePath, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Template error in ${entry.outputPath}: ${message}`,
      'RENDER_TEMPLATE_ERROR',
      'Check the template for Nunjucks syntax errors.',
    );
  }
}

function renderEach(
  entry: FileEntry,
  source: string,
  context: RenderContext,
  env: nunjucks.Environment,
  volatile: boolean,
): RenderedFile[] {
  const list = context.values[entry.iterator!];
  if (!Array.isArray(list)) {
    throw new ShardMindError(
      `Template ${entry.outputPath} is an _each template but values.${entry.iterator} is not an array`,
      'RENDER_ITERATOR_ERROR',
      `Ensure values.${entry.iterator} is a list in shard-values.yaml.`,
    );
  }

  const outputPaths = eachOutputPaths(entry.outputPath, list);
  return list.map((item: Record<string, unknown>, i) => {
    const itemContext = { ...context.values, ...context, item };
    const outputPath = outputPaths[i]!;
    const content = renderContent(source, itemContext, env, outputPath);
    return buildRenderedFile(outputPath, content, volatile);
  });
}

/**
 * The paths an `_each` template expands to, one per list item: `_each` in
 * the template's output path replaced by the item itself when it is a
 * string or number, else by its sanitized `slug` (or `name`). The install plan calls this too, so it can back up a user file
 * at an expanded path before the write (#214); sharing it keeps the plan
 * and the write from ever naming different files.
 */
export function eachOutputPaths(outputPath: string, list: readonly unknown[]): string[] {
  const dir = path.posix.dirname(outputPath);
  const base = path.posix.basename(outputPath);
  const paths = list.map((item) => {
    // A string, number or boolean item (the wizard's list input produces
    // strings) names its own file (#227); an object item names it by `slug`,
    // else `name`. Anything else has no name to give.
    const isObject = typeof item === 'object' && item !== null;
    if (!isObject && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new ShardMindError(
        `An _each item for ${outputPath} is ${item === null ? 'null' : typeof item}`,
        'RENDER_ITERATOR_ERROR',
        'Each list item must be a string, a number, a boolean, or an object with a slug or name.',
      );
    }
    const raw = isObject
      ? ((item as Record<string, unknown>)['slug'] ?? (item as Record<string, unknown>)['name'] ?? 'unknown')
      : item;
    const slug = sanitizeSlug(String(raw));
    // Only the basename's `_each`, and a replacer function, so a `$&` or
    // `$'` in the slug is taken literally rather than as a pattern.
    const named = base.replace('_each', () => slug);
    return dir === '.' ? named : `${dir}/${named}`;
  });
  refuseNameClashes(outputPath, list, paths);
  return paths;
}

/**
 * Two items that name the same file would overwrite each other (the last
 * one wins) and, on a case-insensitive filesystem, record two state
 * entries for one file (#234). Compared case-insensitively on every OS, so
 * a shard's list behaves the same everywhere.
 */
function refuseNameClashes(outputPath: string, list: readonly unknown[], paths: readonly string[]): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < paths.length; i++) {
    // The same fold the vault-path guard and rename migrations use: NFC,
    // then case, so `Café` in either Unicode form is one name.
    const key = foldOutputPath(paths[i]!);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, i);
      continue;
    }
    // The iterator is the template's folder (modules.ts extractIterator).
    const listKey = path.posix.basename(path.posix.dirname(outputPath));
    const nameless = [list[first], list[i]].some((item) => itemLabel(item) === null);
    throw new ShardMindError(
      `Items ${first + 1} (${showItem(list[first])}) and ${i + 1} (${showItem(list[i])}) of values.${listKey} both name ${paths[i]}`,
      'RENDER_ITERATOR_NAME_CLASH',
      nameless
        ? `Give every item of values.${listKey} a slug or name (in shard-values.yaml, or at the wizard's prompt): items without one are all named "unknown".`
        : `Give each item of values.${listKey} a name that differs by more than case or by characters a file name cannot hold (such as / or a trailing dot). Edit it in shard-values.yaml, or at the wizard's prompt.`,
    );
  }
}

/** The name an item gives its file before sanitizing, or null when it has none. */
function itemLabel(item: unknown): string | null {
  if (typeof item === 'object' && item !== null) {
    const fields = item as Record<string, unknown>;
    const raw = fields['slug'] ?? fields['name'];
    return raw === undefined || raw === null ? null : String(raw);
  }
  return String(item);
}

/** An item for an error message: its name, quoted and capped, never the whole object. */
function showItem(item: unknown): string {
  const label = itemLabel(item);
  if (label === null) return 'no slug or name';
  return JSON.stringify(label.length > 60 ? `${label.slice(0, 57)}...` : label);
}

/**
 * The list item an `_each` template expanded into `outputPath`, or undefined
 * when no item names that file (the list changed, or isn't a list) or the
 * template is not an `_each` one. Uses the same naming rule as the render,
 * so a re-render of a tracked `_each` file (the update merge, status's line
 * counts) sees the item it was made from (#233).
 */
export function eachItemFor(templateOutputPath: string, list: unknown, outputPath: string): unknown {
  if (!Array.isArray(list) || !path.posix.basename(templateOutputPath).includes('_each')) return undefined;
  for (const item of list) {
    try {
      if (eachOutputPaths(templateOutputPath, [item])[0] === outputPath) return item;
    } catch (err) {
      // An item that names no file (null, say) can't be this file's.
      if (!(err instanceof ShardMindError && err.code === 'RENDER_ITERATOR_ERROR')) throw err;
    }
  }
  return undefined;
}

/**
 * The item for a tracked file rendered from template `templateKey` (a
 * shard-relative source path, as `state.files[].template` holds it), read
 * from `values`. The iterator is the template's folder, as the walk names it.
 */
export function itemForTemplate(
  templateKey: string | null | undefined,
  values: Record<string, unknown>,
  outputPath: string,
): unknown {
  if (!templateKey) return undefined;
  const templateOutputPath = stripNjk(toPosixPath(templateKey));
  const iterator = path.posix.basename(path.posix.dirname(templateOutputPath));
  if (iterator === '.' || iterator === '') return undefined;
  return eachItemFor(templateOutputPath, values[iterator], outputPath);
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

function renderContent(
  source: string,
  context: RenderContext,
  env: nunjucks.Environment,
  filePath: string,
): string {
  // Spread values first so built-in context keys (install_date, year, shard, etc.) win
  const flatContext = { ...context.values, ...context };
  const match = source.match(FRONTMATTER_REGEX);

  if (match) {
    return renderWithFrontmatter(match[1]!, match[2]!, flatContext, env, filePath);
  }

  return renderTemplate(source, flatContext, env, filePath);
}

function renderWithFrontmatter(
  frontmatterRaw: string,
  bodyRaw: string,
  context: Record<string, unknown>,
  env: nunjucks.Environment,
  filePath: string,
): string {
  const safeFm = renderFrontmatterSafely(frontmatterRaw, context, env, filePath);
  const renderedBody = renderTemplate(bodyRaw, context, env, filePath);
  return `---\n${safeFm}\n---\n${renderedBody}`;
}

/**
 * Render the frontmatter, then `parseYaml` → `stringifyYaml` so the stored
 * shape is stable. If a template substitutes a value that contains YAML
 * special characters (colon, pipe, quote, etc.) into an unquoted scalar
 * position — e.g. `owner: {{ name }}` with `name = "foo: bar"` — the naive
 * render produces invalid YAML.
 *
 * Rather than punt to the template author, attempt a one-shot recovery:
 * re-render with every string value in the context replaced by its
 * JSON-encoded form (which is always a valid YAML double-quoted scalar).
 * Non-string leaves (numbers, booleans, arrays, nested objects) are left
 * untouched so their intended YAML type is preserved.
 *
 * If recovery still fails, throw — that means the template itself produces
 * non-YAML output independent of the values, which is a template bug.
 */
function renderFrontmatterSafely(
  frontmatterRaw: string,
  context: Record<string, unknown>,
  env: nunjucks.Environment,
  filePath: string,
): string {
  const firstAttempt = renderTemplate(frontmatterRaw, context, env, filePath);
  const firstParse = tryParseYaml(firstAttempt);
  if (firstParse.ok) {
    return stringifyYaml(firstParse.value, { lineWidth: 0 }).trimEnd();
  }

  const escapedContext = encodeStringLeaves(context) as Record<string, unknown>;
  const secondAttempt = renderTemplate(frontmatterRaw, escapedContext, env, filePath);
  const secondParse = tryParseYaml(secondAttempt);
  if (secondParse.ok) {
    return stringifyYaml(secondParse.value, { lineWidth: 0 }).trimEnd();
  }

  throw new ShardMindError(
    `Frontmatter in ${filePath} rendered invalid YAML: ${firstParse.error}`,
    'RENDER_FRONTMATTER_ERROR',
    'The template frontmatter is syntactically invalid even with YAML-safe value substitution. Check the raw template frontmatter for structural issues.',
  );
}

type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

function tryParseYaml(source: string): ParseResult {
  try {
    return { ok: true, value: parseYaml(source) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Walk a value tree and JSON-encode every string leaf. The result is still
 * a plain JS value — numbers/booleans/nested objects are unchanged — but
 * any string that gets substituted into a YAML scalar position will land
 * as a double-quoted form ("foo: bar") and parse as a string.
 *
 * Guards against circular references: a value may reach itself through a
 * hook-computed default or other user-supplied structure; we break the
 * cycle by returning the already-encoded stand-in, so the walk terminates.
 */
function encodeStringLeaves(value: unknown, seen: WeakMap<object, unknown> = new WeakMap()): unknown {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || typeof value !== 'object') return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(encodeStringLeaves(item, seen));
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) {
    out[k] = encodeStringLeaves(v, seen);
  }
  return out;
}

function renderTemplate(
  source: string,
  context: Record<string, unknown>,
  env: nunjucks.Environment,
  filePath: string,
): string {
  try {
    return env.renderString(source, context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Template error in ${filePath}: ${message}`,
      'RENDER_TEMPLATE_ERROR',
      'Check the template for Nunjucks syntax errors.',
    );
  }
}

/**
 * Windows-reserved device names. NTFS refuses to create a file with any
 * of these as its basename (case-insensitive), WITH OR WITHOUT an
 * extension — `CON.txt`, `LPT1.md`, `AUX.foo.bar` all crash on Windows
 * the same way bare `CON` does. The regex matches on the STEM (the
 * portion before the first dot) so we catch both shapes.
 *
 * Install succeeds on POSIX but crashes on Windows with EINVAL / EACCES;
 * we rewrite them to a safe form so shards written against Linux don't
 * silently break on a Windows user.
 */
const WINDOWS_RESERVED_NAMES_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function sanitizeSlug(slug: string): string {
  let out = slug
    .replace(/[/\\]/g, '-')
    .replace(/\.\./g, '-')
    .replace(/[<>:"|?*\x00-\x1f]/g, '-')
    .trim();
  // NTFS silently strips trailing `.` and space from filenames, which
  // produces a different-named file than the slug we planned with —
  // fold them up front so the output path and the rendered state agree.
  out = out.replace(/[. ]+$/, '');
  // A slug of only dots / spaces / control chars collapses to an empty
  // string after the rewrites above. Emitting "" produces an output
  // path like `foo/.md` (a dotfile on POSIX; invisible on Windows),
  // which disagrees with the planned shape. Fall back to `_` so every
  // valid shard produces at least one legible path component.
  if (!out) out = '_';
  // Reserved-name check runs on the stem — NTFS blocks `CON.txt` just
  // as hard as bare `CON`.
  const dotIndex = out.indexOf('.');
  const stem = dotIndex === -1 ? out : out.slice(0, dotIndex);
  if (WINDOWS_RESERVED_NAMES_RE.test(stem)) out = `_${out}`;
  return out;
}

function buildRenderedFile(outputPath: string, content: string, volatile: boolean): RenderedFile {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return { outputPath, content, hash, volatile };
}
