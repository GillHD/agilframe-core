/**
 * Docs CMS storage (admin-editable documentation).
 *
 * Bundled repository docs (`env.docsDir`) stay read-only; edited/uploaded copies
 * live in `AGIL_DOCS_DATA_DIR` (default `AGIL_DATA_DIR/docs`). This directory
 * holds publications, their history and the default document setting.
 *
 * All names go through the same strict regex + resolved-path check, so traversal
 * (`../`, absolute paths, nested directories) is impossible.
 */
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isWikiDocument, parseWikiMarkdown } from '@agil/protocol';
import type {
  DocContentResponse,
  DocEntry,
  DocHistoryResponse,
  DocVersion,
} from '@agil/protocol';
import type { Env } from './env.js';

export const MAX_DOC_BYTES = 200 * 1024;
export const DOC_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,120}\.(md|txt)$/i;
export const DEFAULT_DOC_NAME = 'api-guide.md';
const DOC_VERSION_ID_RE = /^[0-9]{10,16}-[a-z0-9]{4,16}$/i;

export class DocsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DocsError';
    this.status = status;
    this.code = code;
  }
}

function assertName(name: string): string {
  const value = String(name ?? '').trim();
  if (!DOC_NAME_RE.test(value) || value.includes('..')) {
    throw new DocsError(400, 'validation_failed', 'Invalid document name (use [a-z0-9._-]+.md)');
  }
  return value;
}

function titleOf(name: string, content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1].slice(0, 200);
  }
  return name.replace(/\.(md|txt)$/i, '').replace(/[-_]+/g, ' ');
}

function authoredContent(title: string | undefined, content: string): string {
  if (!title) return content;
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#\s+/.test(line));
  const heading = `# ${title.trim().slice(0, 200)}`;
  if (headingIndex >= 0) {
    lines[headingIndex] = heading;
    return lines.join('\n');
  }
  return `${heading}\n\n${content}`;
}

function publicationRevision(publication: { content: string; custom: boolean }): string {
  return createHash('sha256').update(publication.custom ? 'custom\0' : 'bundled\0').update(publication.content).digest('hex');
}

function replaceFile(filePath: string, content: string): void {
  const pending = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(pending, content, 'utf8');
    renameSync(pending, filePath);
  } finally {
    rmSync(pending, { force: true });
  }
}

function assertWritableDirectory(directory: string): void {
  try {
    if (!statSync(directory).isDirectory()) throw new Error('Path is not a directory');
    accessSync(directory, constants.W_OK);
  } catch (cause) {
    throw new Error(`AGIL_DOCS_DATA_DIR requires an existing writable directory: ${directory}`, { cause });
  }
}

export interface DocsStoreOptions {
  env: Env;
}

export class DocsStore {
  readonly bundledDir: string;
  readonly customDir: string;
  readonly historyDir: string;
  readonly defaultFile: string;

  constructor(options: DocsStoreOptions) {
    this.bundledDir = path.resolve(options.env.docsDir);
    const { docsDataDir, dataDir } = options.env;
    this.customDir = docsDataDir || path.resolve(dataDir, 'docs');
    if (docsDataDir) assertWritableDirectory(this.customDir);
    if (this.customDir === this.bundledDir || (docsDataDir && existsSync(this.bundledDir)
        && realpathSync(this.customDir) === realpathSync(this.bundledDir))) {
      throw new Error('AGIL_DOCS_DATA_DIR and AGIL_DOCS_DIR must be separate directories');
    }
    this.historyDir = path.join(this.customDir, '.history');
    this.defaultFile = path.join(this.customDir, '.default.json');
    this.ensureDirs();
    if (docsDataDir) assertWritableDirectory(this.historyDir);
  }

  private ensureDirs(): void {
    mkdirSync(this.customDir, { recursive: true });
    mkdirSync(this.historyDir, { recursive: true });
  }

  private customPath(name: string): string {
    const resolved = path.resolve(this.customDir, name);
    if (!resolved.startsWith(this.customDir + path.sep)) {
      throw new DocsError(400, 'validation_failed', 'Invalid document path');
    }
    return resolved;
  }

  private bundledPath(name: string): string {
    const resolved = path.resolve(this.bundledDir, name);
    if (!resolved.startsWith(this.bundledDir + path.sep)) {
      throw new DocsError(400, 'validation_failed', 'Invalid document path');
    }
    return resolved;
  }

  private readIfFile(filePath: string): { content: string; updatedAt: number } | null {
    try {
      if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
      return { content: readFileSync(filePath, 'utf8'), updatedAt: statSync(filePath).mtimeMs };
    } catch {
      return null;
    }
  }

  private defaultNameFromDisk(): string | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.defaultFile, 'utf8')) as { name?: unknown };
      return typeof raw.name === 'string' && DOC_NAME_RE.test(raw.name) && !raw.name.includes('..') ? raw.name : undefined;
    } catch {
      return undefined;
    }
  }

  /** Effective default document (validated against the available documents). */
  defaultName(): string {
    const configured = this.defaultNameFromDisk();
    const names = this.listNames();
    if (configured && names.includes(configured)) return configured;
    if (names.includes(DEFAULT_DOC_NAME)) return DEFAULT_DOC_NAME;
    return names[0] ?? DEFAULT_DOC_NAME;
  }

  private listNames(): string[] {
    const names = new Set<string>();
    for (const dir of [this.bundledDir, this.customDir]) {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !DOC_NAME_RE.test(entry.name) || entry.name.includes('..')) continue;
          names.add(entry.name);
        }
      } catch {
        /* dir missing */
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  private currentVersion(name: string, file: { content: string; updatedAt: number }): DocVersion {
    const hash = createHash('sha256').update(file.content).digest('hex').slice(0, 8);
    return {
      id: `${Math.trunc(file.updatedAt)}-current${hash}`,
      name,
      createdAt: file.updatedAt,
      sizeBytes: Buffer.byteLength(file.content, 'utf8'),
      author: 'admin',
      isCurrent: true,
    };
  }

  versions(name: string): DocVersion[] {
    const safeName = assertName(name);
    const dir = path.join(this.historyDir, safeName);
    const current = this.readIfFile(this.customPath(safeName));
    const history: DocVersion[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      /* history directory may not exist yet */
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      if (!DOC_VERSION_ID_RE.test(id)) continue;
      const entry = this.readArchivedVersion(safeName, id);
      if (entry) history.push(entry.version);
    }
    history.sort((a, b) => b.createdAt - a.createdAt);
    return current ? [this.currentVersion(safeName, current), ...history] : history;
  }

  history(name: string): DocHistoryResponse {
    return { name: assertName(name), versions: this.versions(name) };
  }

  private archive(name: string, content: string, title: string, note?: string): DocVersion {
    mkdirSync(path.join(this.historyDir, name), { recursive: true });
    const createdAt = Date.now();
    const id = `${createdAt}-${randomUUID().slice(0, 8)}`;
    const filePath = path.join(this.historyDir, name, `${id}.json`);
    const payload = {
      id,
      name,
      createdAt,
      author: 'admin',
      ...(note ? { note } : {}),
      title,
      content,
    };
    const body = JSON.stringify(payload);
    mkdirSync(path.dirname(filePath), { recursive: true });
    replaceFile(filePath, body);
    return {
      id,
      name,
      createdAt,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      author: 'admin',
      ...(note ? { note } : {}),
      isCurrent: false,
    };
  }

  list(): { docs: DocEntry[]; defaultName: string; editable: true } {
    const defaultName = this.defaultName();
    const docs: DocEntry[] = [];
    for (const name of this.listNames()) {
      const bundled = this.readIfFile(this.bundledPath(name));
      const custom = this.readIfFile(this.customPath(name));
      const effective = custom ?? bundled;
      if (!effective) continue;
      docs.push({
        name,
        title: titleOf(name, effective.content),
        sizeBytes: Buffer.byteLength(effective.content, 'utf8'),
        updatedAt: effective.updatedAt,
        bundled: Boolean(bundled),
        custom: Boolean(custom),
        isDefault: name === defaultName,
        versions: this.versions(name).length,
      });
    }
    return { docs, defaultName, editable: true };
  }

  read(name: string): DocContentResponse {
    const safeName = assertName(name);
    const custom = this.readIfFile(this.customPath(safeName));
    const bundled = this.readIfFile(this.bundledPath(safeName));
    const effective = custom ?? bundled;
    if (!effective) throw new DocsError(404, 'not_found', 'Document not found');
    return {
      name: safeName,
      title: titleOf(safeName, effective.content),
      content: effective.content,
      revision: publicationRevision({ content: effective.content, custom: Boolean(custom) }),
      updatedAt: effective.updatedAt,
      bundled: Boolean(bundled),
      custom: Boolean(custom),
      isDefault: safeName === this.defaultName(),
    };
  }

  /** Read-only lookup used by the public `/docs/:file` handler (custom wins). */
  effectiveContent(name: string): { content: string; custom: boolean; bundled: boolean } | null {
    let safeName: string;
    try {
      safeName = assertName(name);
    } catch {
      return null;
    }
    const custom = this.readIfFile(this.customPath(safeName));
    const bundled = this.readIfFile(this.bundledPath(safeName));
    const effective = custom ?? bundled;
    if (!effective) return null;
    return { content: effective.content, custom: Boolean(custom), bundled: Boolean(bundled) };
  }

  write(name: string, content: string, title?: string, note?: string, expectedRevision?: string | null): DocContentResponse {
    const safeName = assertName(name);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_DOC_BYTES) throw new DocsError(413, 'payload_too_large', `Document exceeds ${MAX_DOC_BYTES} bytes`);
    const previous = this.effectiveContent(safeName);
    this.assertRevision(previous, expectedRevision);
    const nextContent = authoredContent(title, content);
    if (isWikiDocument(safeName)) {
      const { invalidAnchor, missingAnchor } = parseWikiMarkdown(nextContent);
      if (invalidAnchor) {
        throw new DocsError(400, 'wiki_anchor_conflict', `Wiki anchor "${invalidAnchor}" is reserved or used more than once`);
      }
      // Archive restoration republishes the exact older text, even if it predates reference validation.
      if (missingAnchor && !note?.startsWith('restore:')) {
        throw new DocsError(400, 'wiki_anchor_missing', `Wiki link "#${missingAnchor.id}" on line ${missingAnchor.line} has no target`);
      }
    }
    if (previous && previous.content !== nextContent) {
      this.archive(safeName, previous.content, titleOf(safeName, previous.content), note);
    }
    const filePath = this.customPath(safeName);
    mkdirSync(path.dirname(filePath), { recursive: true });
    replaceFile(filePath, nextContent);
    return this.read(safeName);
  }

  private assertRevision(publication: { content: string; custom: boolean } | null, expectedRevision?: string | null): void {
    if (expectedRevision === undefined) return;
    const currentRevision = publication ? publicationRevision(publication) : null;
    if (currentRevision !== expectedRevision) {
      throw new DocsError(409, 'document_conflict', 'The published document changed. Review the current version before trying again.');
    }
  }

  upload(name: string, content: string, title?: string, expectedRevision?: string | null): DocContentResponse {
    const safeName = assertName(name);
    return this.write(safeName, content, title, 'upload', expectedRevision);
  }

  /** Removes the custom copy (reset to bundled, or delete an uploaded-only doc). */
  reset(name: string, expectedRevision?: string): { name: string; reset: boolean; bundled: boolean; custom: false } {
    const safeName = assertName(name);
    if (expectedRevision !== undefined) this.assertRevision(this.effectiveContent(safeName), expectedRevision);
    const custom = this.customPath(safeName);
    const bundled = Boolean(this.readIfFile(this.bundledPath(safeName)));
    const hadCustom = existsSync(custom);
    if (hadCustom) {
      const published = this.readIfFile(custom);
      if (bundled && published) this.archive(safeName, published.content, titleOf(safeName, published.content), 'reset');
      rmSync(custom, { force: true });
    }
    if (!hadCustom && !bundled) throw new DocsError(404, 'not_found', 'Document not found');
    if (!bundled && this.defaultNameFromDisk() === safeName) {
      try {
        rmSync(this.defaultFile, { force: true });
      } catch {
        /* ignore */
      }
    }
    return { name: safeName, reset: true, bundled, custom: false };
  }

  setDefault(name: string): { name: string; defaultName: string } {
    const safeName = assertName(name);
    if (!this.effectiveContent(safeName)) throw new DocsError(404, 'not_found', 'Document not found');
    replaceFile(this.defaultFile, JSON.stringify({ name: safeName, updatedAt: Date.now() }));
    return { name: safeName, defaultName: safeName };
  }

  versionContent(name: string, id: string): { version: DocVersion; content: string } {
    const safeName = assertName(name);
    const safeId = String(id ?? '');
    if (!DOC_VERSION_ID_RE.test(safeId)) throw new DocsError(400, 'validation_failed', 'Invalid version id');
    const current = this.readIfFile(this.customPath(safeName));
    if (current) {
      const version = this.currentVersion(safeName, current);
      if (safeId === version.id) return { version, content: current.content };
    }
    const entry = this.readArchivedVersion(safeName, safeId);
    if (!entry) throw new DocsError(404, 'not_found', 'Version not found');
    return entry;
  }

  private readArchivedVersion(name: string, id: string): { version: DocVersion; content: string } | null {
    const directory = path.join(this.historyDir, name);
    const filePath = path.resolve(directory, `${id}.json`);
    if (!filePath.startsWith(directory + path.sep)) return null;
    const file = this.readIfFile(filePath);
    if (!file) return null;
    let parsed: { content?: unknown; createdAt?: unknown; note?: unknown } | null;
    try {
      parsed = JSON.parse(file.content) as typeof parsed;
    } catch {
      return null;
    }
    if (typeof parsed?.content !== 'string') return null;
    return {
      version: {
        id,
        name,
        createdAt: typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt) ? parsed.createdAt : file.updatedAt,
        sizeBytes: Buffer.byteLength(parsed.content, 'utf8'),
        author: 'admin',
        ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
        isCurrent: false,
      },
      content: parsed.content,
    };
  }

  restore(name: string, id: string, expectedRevision?: string): DocContentResponse {
    const { content } = this.versionContent(name, id);
    return this.write(name, content, undefined, `restore:${id}`, expectedRevision);
  }
}

/** Sanitises a client-supplied upload file name (no directories, lowercased). */
export function sanitizeDocName(raw: string): string {
  let decoded = String(raw ?? '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep raw */
  }
  const base = path.basename(decoded.replace(/\\/g, '/')).trim().toLowerCase();
  if (!DOC_NAME_RE.test(base) || base.includes('..')) {
    throw new DocsError(400, 'validation_failed', 'Invalid file name: expected *.md or *.txt (no paths)');
  }
  return base;
}
