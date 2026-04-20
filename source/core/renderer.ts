import fs from 'node:fs/promises';
import crypto from 'node:crypto';
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

export function createRenderer(templateDir: string): nunjucks.Environment {
  return nunjucks.configure(templateDir, NUNJUCKS_OPTS);
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
 * Build the Nunjucks render context for an install or update operation.
 * Centralizes the shape so the two commands can't drift apart on what's
 * available to templates.
 */
export function buildRenderContext(
  manifest: ShardManifest,
  values: Record<string, unknown>,
  selections: ModuleSelections,
  now: Date = new Date(),
): RenderContext {
  const included_modules = Object.entries(selections)
    .filter(([, s]) => s === 'included')
    .map(([id]) => id);

  return {
    values,
    included_modules,
    shard: { name: manifest.name, version: manifest.version },
    install_date: now.toISOString(),
    year: now.getUTCFullYear().toString(),
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

  return list.map((item: Record<string, unknown>) => {
    const itemContext = { ...context.values, ...context, item };
    const rawSlug = String(item['slug'] ?? item['name'] ?? 'unknown');
    const slug = sanitizeSlug(rawSlug);
    const outputPath = entry.outputPath.replace('_each', slug);
    const content = renderContent(source, itemContext, env, outputPath);
    return buildRenderedFile(outputPath, content, volatile);
  });
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
