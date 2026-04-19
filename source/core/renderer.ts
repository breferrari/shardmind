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
    defaultStringEnv = new nunjucks.Environment(null, NUNJUCKS_OPTS);
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
  // Render frontmatter with Nunjucks
  const renderedFm = renderTemplate(frontmatterRaw, context, env, filePath);

  // Parse → stringify for safe YAML escaping
  let safeFm: string;
  try {
    const parsed = parseYaml(renderedFm);
    safeFm = stringifyYaml(parsed, { lineWidth: 0 }).trimEnd();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Frontmatter in ${filePath} rendered invalid YAML: ${message}`,
      'RENDER_FRONTMATTER_ERROR',
      'Check template frontmatter for syntax issues after value substitution.',
    );
  }

  // Render body
  const renderedBody = renderTemplate(bodyRaw, context, env, filePath);

  return `---\n${safeFm}\n---\n${renderedBody}`;
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

function sanitizeSlug(slug: string): string {
  return slug
    .replace(/[/\\]/g, '-')
    .replace(/\.\./g, '-')
    .replace(/[<>:"|?*\x00-\x1f]/g, '-')
    .trim();
}

function buildRenderedFile(outputPath: string, content: string, volatile: boolean): RenderedFile {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return { outputPath, content, hash, volatile };
}
