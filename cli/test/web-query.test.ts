import { WebAuth } from '../src/web/auth.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { prepareWebQuery } from '../src/web/query.js';
import { AsideWebServer, type WebBackend } from '../src/web/server.js';
import { availableInstances } from '../src/web/catalogue.js';
import { executeGraphQL } from '../src/graphql/schema.js';
import { Store } from '../src/mcp/store.js';
import { WEB_QUERY_MAX_RESPONSE_BYTES, WEB_QUERY_TIMEOUT_MS } from '../src/core/web-query.js';

const rejected = (query: string, variables?: Record<string, unknown>) => {
  const prepared = prepareWebQuery({ query, variables });
  expect('result' in prepared).toBe(true);
  return 'result' in prepared ? JSON.stringify(prepared.result.errors) : '';
};
describe('webpage GraphQL policy', () => {
  it('accepts record queries with variables, aliases, fragments, unions and nested relationships', () => {
    const prepared = prepareWebQuery({ query: `query Dashboard($limit: Int = 25) {
      work: actions(limit: $limit) { totalCount nodes { ...Item projects { nodes { id name } } } }
      artifacts(limit: 2) { nodes { content { ... on MarkdownContent { text } ... on Attachment { filename } } } }
    } fragment Item on Action { id name status }` });
    expect('args' in prepared).toBe(true);
  });
  it.each(['{ instances { id } }', '{ activeInstance { id } }', '{ __schema { types { name } } }',
    '{ __type(name:"Action") { name } }', '{ project(id:"x") { automations { nodes { name } } } }',
    '{ projects { nodes { automationLog { nodes { id } } } } }',
    'query { hidden: activeInstance @skip(if:true) { execution { models { name } } } }',
    'query { projects { nodes { ...Runtime } } } fragment Runtime on Project { jobs: automations { totalCount } }'])('rejects privileged selections: %s', query => {
    expect(rejected(query)).toMatch(/unavailable|Cannot query field/);
  });
  it.each(['mutation { selectInstance(path:"/tmp") { error } }', 'mutation { showUrl }',
    'query Safe { actions { totalCount } } mutation Other { selectInstance(path:"/tmp") { error } }',
    'query One { entries { totalCount } } query Two { actions { totalCount } }'])('rejects extra or non-query operations: %s', query => {
    expect(rejected(query)).toMatch(/query|operationName/);
  });
  it('bounds alias breadth, fragment expansion, nested page cost and variable page sizes', () => {
    expect(rejected(`{ ${Array.from({length: 11}, (_, i) => `a${i}: actions { totalCount }`).join(' ')} }`)).toContain('budget');
    expect(rejected('{ projects(limit:100) { nodes { actions(limit:100) { nodes { id name } } } } }')).toContain('budget');
    expect(rejected('query($n:Int=101) { actions(limit:$n) { nodes { id } } }')).toContain('1 to 100');
    expect(rejected('query($n:Int!) { actions(limit:$n) { nodes { id } } }', { n: 0 })).toContain('1 to 100');
    expect(rejected(`{project(id:"x"){${Array.from({length:201},(_,i)=>`n${i}:name`).join(' ')}}}`)).toContain('budget');
    expect(rejected('{action(id:"x"){occurrence{template{occurrence{template{occurrence{template{occurrence{original}}}}}}}}}')).toContain('budget');
    expect(rejected('query { projects { nodes { ...Cycle } } } fragment Cycle on Project { ...Cycle }')).toMatch(/cycle/i);
  });
  it('rejects malformed requests, routing overrides and excessive bytes', () => {
    for (const input of [null, [], {query: 12}, {query:'{actions{totalCount}}', instance:'/other'},
      {query:'{actions{totalCount}}',variables:[]}, {query:'{__typename}', variables:{padding:'x'.repeat(64*1024)}}]) {
      expect('result' in prepareWebQuery(input)).toBe(true);
    }
  });
});

describe('localhost GraphQL queries', () => {
  let authorization: string;
  let fixture: string, server: AsideWebServer, backend: WebBackend;
  const stores = new Map<string, Store>();
  const paths: string[] = [];
  const project = '2026-10-12-work';
  beforeAll(() => {
    fixture = realpathSync(mkdtempSync('/tmp/aside-web-query-'));
    for (const id of ['first', 'second']) {
      const root = join(fixture, id); paths.push(root);
      mkdirSync(join(root, 'projects', '2026'), {recursive:true});
      writeFileSync(join(root,'aside.md'), `---\nid: ${id}\nname: ${id}\n---\n`);
      writeFileSync(join(root,'projects','2026','index.yaml'), `- id: ${project}\n  description: ${id}\n`);
      writeFileSync(join(root,'projects','2026',`${project}.md`), `---\nname: ${id}\ncreated: 2026-10-12T09:00\n---\nBody for ${id}.`);
      stores.set(root, new Store(root));
    }
  });
  afterAll(() => { for (const store of stores.values()) store.close(); rmSync(fixture, {recursive:true,force:true}); });
  beforeEach(async () => {
    backend = { instances: () => availableInstances(paths), register:async()=>null, remove:()=>{}, load:()=>{},
      data: async path => stores.get(path)!.snapshot(),
      query: vi.fn((path,args,signal) => executeGraphQL(stores.get(path)!, 'query', args, {signal, maxFields:10_000, maxResponseBytes:WEB_QUERY_MAX_RESPONSE_BYTES})),
    };
    const auth = new WebAuth(join(fixture, 'auth'));
    authorization = `Bearer ${auth.issue().token}`;
    server = (await AsideWebServer.start(join(fixture,'app'), backend, 0, { auth, stateDirectory: join(fixture, 'auth') }))!;
  });
  afterEach(() => { server.close(); vi.restoreAllMocks(); });
  const post = (input: unknown, id = 'first', headers: Record<string,string> = {}, signal?: AbortSignal) => fetch(`http://127.0.0.1:${server.port}/-/api/instances/${id}/graphql`, {
    method:'POST', headers:{Authorization: authorization, 'Content-Type':'application/json','X-Aside-Control':'1', ...headers}, body:JSON.stringify(input), signal,
  });
  it('queries the exact instance independently of another instance with the same record ID', async () => {
    for (const instance of ['first','second']) {
      const response = await post({query:'query($id:ID!){ project(id:$id){id name body} }',variables:{id:project}}, instance);
      expect(response.status).toBe(200); expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(await response.json()).toMatchObject({data:{project:{id:project,name:instance,body:`Body for ${instance}.`}},extensions:{complete:true,mutations:[]}});
    }
  });
  it('keeps forbidden queries away from the backend', async () => {
    for (const query of ['{ instances { id } }','{ project(id:"x") { automations { totalCount } } }','mutation { selectInstance(path:"/other") { error } }', 'mutation { showUrl }']) {
      const response = await post({query}); expect((await response.json()).errors).toBeDefined();
    }
    expect(backend.query).not.toHaveBeenCalled();
  });
  it('rejects foreign origins, opaque iframe origins, missing control headers and non-POST methods', async () => {
    for (const headers of [{Origin:'null'},{Origin:'https://other.example'}, {'X-Aside-Control':''}]) expect((await post({query:'{__typename}'},'first',headers)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${server.port}/-/api/instances/first/graphql`, { headers: { Authorization: authorization } })).status).toBe(405);
    expect((await post({query:'{__typename}'},'missing')).status).toBe(404);
    expect(backend.query).not.toHaveBeenCalled();
  });
  it('preserves partial GraphQL data and diagnostics', async () => {
    backend.query = vi.fn(async()=>({data:{project:null},errors:[{message:'Missing relationship'}],extensions:{complete:false,diagnostics:[{code:'missing'}],mutations:[]}}));
    const response = await post({query:'{projects{totalCount}}'});
    expect(await response.json()).toMatchObject({data:{project:null},errors:[{message:'Missing relationship'}],extensions:{complete:false}});
  });
  it('bounds the serialized response and request body', async () => {
    backend.query = vi.fn(async()=>({data:{text:'x'.repeat(WEB_QUERY_MAX_RESPONSE_BYTES)}}));
    expect((await post({query:'{__typename}'})).status).toBe(413);
    expect((await post({query:'{__typename}',variables:{text:'x'.repeat(64*1024)}})).status).toBe(413);
  });
  it('limits per-instance concurrency and aborts disconnected requests', async () => {
    const signals: AbortSignal[] = [];
    const releases: (()=>void)[] = [];
    backend.query = vi.fn((_path,_args,signal)=>new Promise(resolve=>{
      signals.push(signal); const release=()=>resolve({data:{__typename:'Query'}}); releases.push(release);
      signal.addEventListener('abort',release,{once:true});
    }));
    const controllers = Array.from({length:4},()=>new AbortController());
    const responses = controllers.map(controller=>post({query:'{__typename}'},'first',{},controller.signal).catch(()=>null));
    await vi.waitFor(()=>expect(signals).toHaveLength(4));
    expect((await post({query:'{__typename}'})).status).toBe(429);
    controllers[0].abort(); await vi.waitFor(()=>expect(signals[0].aborted).toBe(true));
    releases.forEach(release=>release()); await Promise.all(responses);
  });
  it('limits per-instance request rate', async () => {
    for (let i=0;i<60;i++) expect((await post({query:'{__typename}'})).status).toBe(200);
    expect((await post({query:'{__typename}'})).status).toBe(429);
    expect((await post({query:'{__typename}'},'second')).status).toBe(200);
  });
  it('times out and cancels backend work', async () => {
    let signal: AbortSignal | undefined;
    backend.query = vi.fn((_path,_args,value)=>{signal=value;return new Promise(resolve=>value.addEventListener('abort',()=>resolve({data:null}),{once:true}));});
    expect((await post({query:'{__typename}'})).status).toBe(504);
    expect(signal?.aborted).toBe(true);
  },15_000);
  it('returns a timeout response for an unfinished request body and releases its slot', async () => {
    const setTimeout_ = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) =>
      setTimeout_(callback, delay === WEB_QUERY_TIMEOUT_MS ? 25 : delay, ...args)) as typeof setTimeout);
    let client: ReturnType<typeof httpRequest> | undefined;
    try {
      const response = await new Promise<{status: number; body: string}>((resolve, reject) => {
        client = httpRequest(`http://127.0.0.1:${server.port}/-/api/instances/first/graphql`, {
          method: 'POST', headers: {Authorization: authorization, 'X-Aside-Control':'1', 'Content-Length':'100'},
        }, incoming => {
          let body = '';
          incoming.on('data', chunk => { body += chunk; });
          incoming.on('end', () => resolve({status: incoming.statusCode!, body}));
          incoming.on('error', reject);
        });
        client.on('error', reject);
        client.write('{"query":');
      });
      expect(response.status).toBe(504);
      expect(JSON.parse(response.body).error).toContain('timed out');
      expect(backend.query).not.toHaveBeenCalled();
      expect((await post({query:'{__typename}'})).status).toBe(200);
    } finally { client?.destroy(); }
  });
});
