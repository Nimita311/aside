import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...segs: string[]) => JSON.parse(readFileSync(join(here, ...segs), 'utf-8'));

// The CLI, source package, and plugin declarations share one release version.
describe('VERSION', () => {
  it('matches package.json', () => {
    expect(VERSION).toBe(read('..', 'package.json').version);
  });

  it('matches the plugin manifest', () => {
    expect(VERSION).toBe(read('..', '..', 'agent', 'graphql', '.claude-plugin', 'plugin.json').version);
  });

  it('matches the marketplace manifest', () => {
    const market = read('..', '..', 'agent', 'graphql', '.claude-plugin', 'marketplace.json');
    const entry = market.plugins.find((p: { name: string }) => p.name === 'aside');
    expect(entry?.version).toBe(VERSION);
  });
});

describe('agent plugin declarations', () => {
  it('points the marketplace at its configuration and skill folder', () => {
    const market = read('..', '..', 'agent', 'graphql', '.claude-plugin', 'marketplace.json');
    expect(market.plugins.find((p: { name: string }) => p.name === 'aside')?.source).toBe('./');
  });

  it('runs the CLI from PATH without a bundled runtime or relative launcher', () => {
    const mcp = read('..', '..', 'agent', 'graphql', '.mcp.json');
    expect(mcp.mcpServers.aside).toEqual({ command: 'aside', args: ['mcp'] });
  });
});
