import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataCore } from '../../cli/src/core/data-core';
import type { DataSnapshot } from '../../cli/src/core/data-snapshot';
import type { DataSource, FileRead } from '../../cli/src/core/data-source';

export const FIXTURE_NAMES = ['showcase', 'empty', 'malformed'] as const;
export type FixtureName = typeof FIXTURE_NAMES[number];
export const MOCK_NOW = '2026-10-18T10:00:00-07:00';
export const SHOWCASE_IDS = {
  project: '2026-10-12-aurora', action: '2026-10-12-review',
  entry: '2026-10-18T09:30', emptyProject: '2026-10-12-empty', emptyAction: '2026-10-12-empty',
  typography: '2026-10-12-typography', diagrams: '2026-10-12-diagrams',
  diagramError: '2026-10-12-diagram-error',
  media: '2026-10-12-media', dashboard: '2026-10-12-dashboard',
} as const;

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const version = (bytes: Uint8Array) => `hash:${createHash('sha256').update(bytes).digest('hex')}`;

// This source deliberately goes through DataCore's ordinary file parsing and
// relationship derivation. Fixtures stay editable as the same files users keep.
class FixtureSource implements DataSource {
  constructor(private readonly root: string, private readonly name: FixtureName) {}

  private path(path: string): string {
    const target = resolve(this.root, path);
    if (target !== this.root && !target.startsWith(this.root + sep)) throw new Error('Fixture path leaves its root.');
    return target;
  }

  async read(path: string): Promise<FileRead | null> {
    try {
      const bytes = await readFile(this.path(path));
      return { text: bytes.toString('utf8'), version: version(bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async revalidate(path: string, previous: string): Promise<FileRead | 'unchanged' | null> {
    const current = await this.read(path);
    return current?.version === previous ? 'unchanged' : current;
  }

  assetUrl(path: string): string {
    this.path(path);
    return `/mock-files/${this.name}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async assetVersion(path: string): Promise<string | null> {
    try {
      const file = await stat(this.path(path));
      return file.isFile() ? `stat:${file.size}:${file.mtimeMs}` : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async listYears(): Promise<string[]> {
    const years = new Set<string>();
    for (const kind of ['notes', 'projects', 'actions', 'artifacts']) {
      try {
        for (const entry of await readdir(this.path(kind), { withFileTypes: true })) {
          if (entry.isDirectory() && /^\d{4}$/.test(entry.name)) years.add(entry.name);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return [...years].sort();
  }
}

async function listFiles(root: string, directory = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

export interface LoadedFixture {
  store: DataCore;
  snapshot: DataSnapshot;
  root: string;
  files: string[];
}

export async function loadFixture(name: FixtureName = 'showcase', options: { fixturesRoot?: string } = {}): Promise<LoadedFixture> {
  if (!FIXTURE_NAMES.includes(name)) throw new Error(`Unknown fixture: ${name}`);
  const root = resolve(options.fixturesRoot ?? fixturesRoot, name);
  const store = new DataCore(new FixtureSource(root, name));
  await store.init();
  await store.warmSearch();
  return { store, snapshot: await store.snapshot(), root, files: await listFiles(root) };
}
