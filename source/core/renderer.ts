import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import nunjucks from 'nunjucks';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { FileEntry, RenderedFile, RenderContext } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';

const VOLATILE_MARKER = '{# shardmind: volatile #}';
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function createRenderer(templateDir: string): nunjucks.Environment {
  return nunjucks.configure(templateDir, {
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
  });
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
    const itemContext = { ...context, ...context.values, item };
    const slug = String(item['slug'] ?? item['name'] ?? 'unknown');
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
  const flatContext = { ...context, ...context.values };
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

function buildRenderedFile(outputPath: string, content: string, volatile: boolean): RenderedFile {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return { outputPath, content, hash, volatile };
}
