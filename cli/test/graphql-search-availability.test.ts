import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { init } from '../src/source/bootstrap.js';
import { buildGraphQLSchema, executeGraphQL, type GraphQLExecutionOptions } from '../src/graphql/schema.js';
import { Store } from '../src/source/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { SemanticSetupError } from '../src/semantic/embedding.js';
import * as availability from '../src/semantic/availability.js';
import type { SemanticAvailability, SemanticAvailabilityReason } from '../src/semantic/availability.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession } from '../src/mcp/instance-session.js';

const availabilityDocument = '{systemInfo{search{semantic{available reason message recovery model}}}}';
const ready: SemanticAvailability = {
  available: true, reason: 'AVAILABLE', message: 'Semantic search is available.',
  recovery: null, model: 'qwen3-embedding:0.6b',
};

describe('agent semantic-search availability', () => {
  let root: string;
  let store: Store;
  const matcher = {match: vi.fn(async (pattern: string, texts: string[][]) =>
    texts.flatMap((fields, index) => fields.some(text => new RegExp(pattern, 'i').test(text)) ? [index] : []))};

  beforeEach(() => {
    root = mkdtempSync('/private/tmp/aside-availability-api-');
    init(root, {name: 'Availability fixture', description: 'Explicit semantic prerequisites'});
    store = new Store(root);
    handleCapture(store, {content: 'The sketch ends in silence.', description: 'Sketch decision'}, new Date(2026, 9, 20, 10));
    matcher.match.mockClear();
  });
  afterEach(() => { store.close(); vi.restoreAllMocks(); rmSync(root, {recursive: true, force: true}); });

  it('reports availability without selecting or loading an instance or running semantic search', async () => {
    const source = vi.fn(() => { throw new Error('No instance is selected.'); });
    const semanticAvailability = vi.fn(async () => ready);
    const semanticSearch = vi.fn(async () => { throw new Error('Inference must not run.'); });
    const result = await executeGraphQL(source, 'query', {document: availabilityDocument}, {semanticAvailability, semanticSearch});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({systemInfo: {search: {semantic: ready}}});
    expect(semanticAvailability).toHaveBeenCalledWith({signal: expect.any(AbortSignal)});
    expect(source).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it.each<Exclude<SemanticAvailabilityReason, 'AVAILABLE'>>([
    'UNSUPPORTED_PLATFORM', 'INDEX_UNAVAILABLE', 'OLLAMA_UNREACHABLE', 'MODEL_MISSING', 'CONFIGURATION_ERROR', 'OLLAMA_ERROR',
  ])('returns an actionable %s status as data instead of a query error', async reason => {
    const unavailable: SemanticAvailability = {...ready, available: false, reason,
      message: `Semantic ranking is unavailable: ${reason}.`, recovery: 'Resolve the reported prerequisite, then query again.'};
    const source = vi.fn(() => { throw new Error('Records must stay unloaded.'); });
    const result = await executeGraphQL(source, 'query', {document: availabilityDocument}, {
      semanticAvailability: vi.fn(async () => unavailable),
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({systemInfo: {search: {semantic: unavailable}}});
    expect(source).not.toHaveBeenCalled();
  });

  it('returns explicit host unavailability when no availability callback is installed', async () => {
    const source = vi.fn(() => { throw new Error('Records must stay unloaded.'); });
    const result = await executeGraphQL(source, 'query', {document: availabilityDocument});
    expect(result.errors).toBeUndefined();
    expect(result.data).toMatchObject({systemInfo: {search: {semantic: {
      available: false, reason: 'INDEX_UNAVAILABLE', model: expect.any(String),
      message: expect.any(String), recovery: expect.any(String),
    }}}});
    expect(source).not.toHaveBeenCalled();
  });

  it('wires the daemon availability probe without activating or loading an instance', async () => {
    const probe = vi.spyOn(availability, 'semanticSearchAvailability').mockResolvedValue(ready);
    const host = new InstanceHost(new CalClient(null));
    const load = vi.spyOn(host, 'load').mockImplementation(() => { throw new Error('No record loading during availability.'); });
    const backend = {knownInstances: vi.fn(async () => []), issues: vi.fn(async () => [])};
    const registry = new InstanceRegistry();
    const session = new InstanceSession(registry, backend, [], false);
    try {
      const result = await host.graphql(session, 'query', {document: availabilityDocument});
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({systemInfo: {search: {semantic: ready}}});
      expect(probe).toHaveBeenCalledWith({signal: expect.any(AbortSignal)});
      expect(registry.activeInstance).toBeNull();
      expect(load).not.toHaveBeenCalled();
      expect(backend.knownInstances).not.toHaveBeenCalled();
      expect(backend.issues).not.toHaveBeenCalled();
    } finally { await host.close(); }
  });

  it('leaves discovery, typed queries, and regex/field ordering independent of the availability probe', async () => {
    const semanticAvailability = vi.fn(async () => { throw new Error('No automatic service probe.'); });
    const semanticSearch = vi.fn(async () => { throw new Error('No automatic model inference.'); });
    const result = await executeGraphQL(store, 'query', {document: `{
      schema: __type(name:"SemanticSearchAvailability"){name}
      entries {totalCount}
      search(where:{entries:{regex:"sketch"}},rankBy:{order:CREATED_DESC}){totalCount hits{kind}}
    }`}, {matcher, semanticAvailability, semanticSearch});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({schema: {name: 'SemanticSearchAvailability'}, entries: {totalCount: 1},
      search: {totalCount: 1, hits: [{kind: 'ENTRY'}]}});
    expect(matcher.match).toHaveBeenCalledOnce();
    expect(semanticAvailability).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it.each<Exclude<SemanticAvailabilityReason, 'AVAILABLE' | 'OLLAMA_ERROR'>>([
    'UNSUPPORTED_PLATFORM', 'INDEX_UNAVAILABLE', 'OLLAMA_UNREACHABLE', 'MODEL_MISSING', 'CONFIGURATION_ERROR',
  ])('preserves structured %s details when semantic ranking is attempted', async reason => {
    const message = `Cannot perform semantic ranking: ${reason}.`;
    const recovery = 'Resolve this prerequisite before retrying semantic ranking.';
    const semanticSearch: NonNullable<GraphQLExecutionOptions['semanticSearch']> = vi.fn(async () => {
      throw new SemanticSetupError(message, {reason, recovery, model: ready.model});
    });
    const semanticAvailability = vi.fn(async () => { throw new Error('Errors already carry their cause.'); });
    const result = await executeGraphQL(store, 'query', {document: '{search(rankBy:{semantic:"Find the ending decision"}){hits{handle}}}'},
      {matcher, semanticSearch, semanticAvailability});
    expect(result.data).toBeNull();
    expect(result.errors).toEqual([expect.objectContaining({message, path: ['search'], extensions: {
      code: 'SEMANTIC_SEARCH_UNAVAILABLE', reason, recovery, model: ready.model,
    }})]);
    expect(semanticSearch).toHaveBeenCalledOnce();
    expect(matcher.match).not.toHaveBeenCalled();
    expect(semanticAvailability).not.toHaveBeenCalled();
  });

  it('distinguishes an inference failure from an unavailable prerequisite', async () => {
    const semanticSearch: NonNullable<GraphQLExecutionOptions['semanticSearch']> = vi.fn(async () => {
      throw new SemanticSetupError('The embedding request failed.', {reason: 'OLLAMA_ERROR', recovery: 'Check the local model service.', model: ready.model});
    });
    const result = await executeGraphQL(store, 'query', {document: '{search(rankBy:{semantic:"ending"}){hits{handle}}}'}, {semanticSearch});
    expect(result.data).toBeNull();
    expect(result.errors).toEqual([expect.objectContaining({extensions: {
      code: 'SEMANTIC_SEARCH_FAILED', reason: 'OLLAMA_ERROR', recovery: 'Check the local model service.', model: ready.model,
    }})]);
  });

  it('reports a missing ranking backend with structured recovery rather than changing the search method', async () => {
    const result = await executeGraphQL(store, 'query', {document: '{search(rankBy:{semantic:"ending"}){hits{handle}}}'}, {matcher});
    expect(result.data).toBeNull();
    expect(result.errors).toEqual([expect.objectContaining({extensions: expect.objectContaining({
      code: 'SEMANTIC_SEARCH_UNAVAILABLE', reason: 'INDEX_UNAVAILABLE', recovery: expect.any(String),
    })})]);
    expect(matcher.match).not.toHaveBeenCalled();
  });

  it('makes availability fields and reasons discoverable through the public schema', () => {
    const schema = buildGraphQLSchema();
    expect(schema.getQueryType()!.getFields().searchAvailability).toBeUndefined();
    expect((schema.getType('SystemSearchInfo') as any).getFields().semantic.type.toString()).toBe('SemanticSearchAvailability!');
    const fields = (schema.getType('SemanticSearchAvailability') as any).getFields();
    expect(new Set(Object.keys(fields))).toEqual(new Set(['available', 'reason', 'message', 'recovery', 'model']));
    expect(fields.available.type.toString()).toBe('Boolean!');
    expect(fields.reason.type.toString()).toBe('SemanticAvailabilityReason!');
    expect(fields.message.type.toString()).toBe('String!');
    expect(fields.recovery.type.toString()).toBe('String');
    expect(fields.model.type.toString()).toBe('String!');
    expect(new Set((schema.getType('SemanticAvailabilityReason') as any).getValues().map((value: any) => value.name))).toEqual(new Set([
      'AVAILABLE', 'UNSUPPORTED_PLATFORM', 'INDEX_UNAVAILABLE', 'OLLAMA_UNREACHABLE', 'MODEL_MISSING', 'CONFIGURATION_ERROR', 'OLLAMA_ERROR',
    ]));
  });
});
