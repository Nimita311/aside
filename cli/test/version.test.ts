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

  it.each(['graphql', 'legacy'])('matches the %s plugin manifest', surface => {
    expect(VERSION).toBe(read('..', '..', 'agent', surface, '.claude-plugin', 'plugin.json').version);
  });

  it.each(['graphql', 'legacy'])('matches the %s marketplace manifest', surface => {
    const market = read('..', '..', 'agent', surface, '.claude-plugin', 'marketplace.json');
    const entry = market.plugins.find((p: { name: string }) => p.name === 'aside');
    expect(entry?.version).toBe(VERSION);
  });
});

describe('agent plugin declarations', () => {
  it.each(['graphql', 'legacy'])('points the %s marketplace at its configuration and skill folder', surface => {
    const market = read('..', '..', 'agent', surface, '.claude-plugin', 'marketplace.json');
    expect(market.plugins.find((p: { name: string }) => p.name === 'aside')?.source).toBe('./');
  });

  it.each(['graphql', 'legacy'])('runs the %s CLI from PATH without a bundled runtime or relative launcher', surface => {
    const mcp = read('..', '..', 'agent', surface, '.mcp.json');
    expect(mcp.mcpServers.aside).toEqual({ command: 'aside', args: ['mcp', ...(surface === 'legacy' ? ['--legacy'] : [])] });
  });
});
