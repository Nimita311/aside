// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIframeQueryBridge } from '../src/iframe-bridge';
import { createIframeQueryClient } from '../src/iframe-sdk';
import { IFRAME_CONNECT } from '../src/iframe-protocol';
import { webpageFrame } from '../src/webpage';
import { WEB_QUERY_TIMEOUT_MS, type WebQueryRequest, type WebQueryResult } from '../../cli/src/core/web-query';

type Query = (request: WebQueryRequest, signal: AbortSignal) => Promise<WebQueryResult>;

class Port {
  peer!: Port;
  onmessage: ((event: MessageEvent)=>void) | null = null;
  onmessageerror: (()=>void) | null = null;
  closed = false;
  messages: unknown[] = [];
  postMessage(message: unknown) {
    if (this.closed) throw new Error('Port closed');
    this.messages.push(message);
    queueMicrotask(()=>{if (!this.peer.closed) this.peer.onmessage?.({data:message} as MessageEvent);});
  }
  start() {}
  close() { this.closed = true; }
}
class Channel {
  port1 = new Port(); port2 = new Port();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; }
}
const bridges: ReturnType<typeof createIframeQueryBridge>[] = [];
const pendingClients: (()=>void)[] = [];
const path = 'artifacts/2026/2026-10-12-dashboard/index.html';
const request = {query:'{ actions { totalCount } }'};
const fileUrl = (file: string) => `/-/files/fixture/work/files/${file}`;
beforeEach(()=>{
  vi.stubGlobal('MessageChannel', Channel);
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>Dashboard</h1>', { headers: { 'Content-Type': 'text/html' } })));
  (window as unknown as {happyDOM:{settings:{navigation:{disableChildFrameNavigation:boolean}}}}).happyDOM.settings.navigation.disableChildFrameNavigation = true;
});
afterEach(()=>{pendingClients.splice(0).forEach(close=>close());bridges.splice(0).forEach(bridge=>bridge.dispose());document.body.replaceChildren();vi.useRealTimers();vi.unstubAllGlobals();});

async function setup(query = vi.fn<Query>(async()=>({data:{actions:{totalCount:3}},extensions:{complete:true}}))) {
  const frame = webpageFrame('Dashboard', path);
  frame.src = `${location.origin}${fileUrl(path)}`;
  const source = {} as Window;
  Object.defineProperty(frame,'contentWindow',{value:source});
  const bridge = createIframeQueryBridge(); bridges.push(bridge);
  let active = true;
  const resource = vi.fn(async () => new Blob(['chart bytes'], { type: 'image/png' }));
  const context = {fileUrl,isCurrent:()=>active,query,resource};
  expect(bridge.register(frame,context)).toBe(true);
  document.body.append(frame);
  await vi.waitFor(() => expect(frame.srcdoc).toContain('data-aside-token'));
  const token = frame.srcdoc.match(/data-aside-token="([^"]+)"/)![1];
  const connect = (channel = new Channel(), overrides: Record<string,unknown> = {}, origin = 'null', sender: Window | null = source) => {
    window.dispatchEvent(new MessageEvent('message',{origin, source:sender, data:{type:IFRAME_CONNECT,version:1,token,...overrides}, ports:[channel.port2 as unknown as MessagePort]}));
    return channel;
  };
  return {frame,bridge,query,resource,source,context,token,connect,deactivate:()=>{active=false;}};
}

describe('iframe query connections',()=>{
  it.each([false, true])('loads only intersecting previews and releases removed pending frames (removed=%s)', async removed => {
    let intersect!: (entries: Array<{target: Element; isIntersecting: boolean}>) => void;
    const observe = vi.fn(), unobserve = vi.fn(), disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe = observe; unobserve = unobserve; disconnect = disconnect;
    });
    const frame = webpageFrame('Dashboard', path); frame.src = `${location.origin}${fileUrl(path)}`;
    const bridge = createIframeQueryBridge(); bridges.push(bridge);
    bridge.register(frame,{fileUrl,isCurrent:()=>true,query:vi.fn(),resource:vi.fn()});
    document.body.append(frame);
    await vi.waitFor(()=>expect(observe).toHaveBeenCalledWith(frame));
    expect(fetch).not.toHaveBeenCalled();
    if (removed) {
      frame.remove();
      await vi.waitFor(()=>expect(unobserve).toHaveBeenCalledWith(frame));
      expect(fetch).not.toHaveBeenCalled();
    } else {
      intersect([{target:frame,isIntersecting:true}]);
      await vi.waitFor(()=>expect(frame.srcdoc).toContain('data-aside-token'));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(unobserve).toHaveBeenCalledWith(frame);
    }
  });
  it('defers bootstrap while suspended and preserves CSP nonces on SDK and authored scripts', async () => {
    const nonce = document.createElement('meta'); nonce.name = 'aside-preview-nonce'; nonce.content = 'fixture-nonce'; document.head.append(nonce);
    vi.mocked(fetch).mockImplementation(async url => new Response(String(url).includes('iframe-client') ? 'window.aside={};' : '<script>document.title="Preview";</script>'));
    const frame = webpageFrame('Dashboard', path); frame.src = `${location.origin}${fileUrl(path)}`;
    const bridge = createIframeQueryBridge(); bridges.push(bridge);
    try {
      bridge.register(frame, {fileUrl,isCurrent:()=>true,query:vi.fn(),resource:vi.fn()});
      bridge.setSuspended(frame,true); document.body.append(frame);
      await new Promise(resolve => setTimeout(resolve,0));
      expect(fetch).not.toHaveBeenCalled(); expect(frame.hasAttribute('src')).toBe(false);
      bridge.setSuspended(frame,false);
      await vi.waitFor(()=>expect(frame.srcdoc).toContain('window.aside'));
      const template = document.createElement('template'); template.innerHTML = frame.srcdoc;
      const scripts = [...template.content.querySelectorAll('script')];
      expect(scripts).toHaveLength(2);
      expect(scripts.every(script=>script.getAttribute('nonce')==='fixture-nonce')).toBe(true);
      expect(scripts[0].getAttribute('data-aside-origin')).toBe(location.origin);
      for (const [,options] of vi.mocked(fetch).mock.calls) {
        expect(options).toMatchObject({credentials:'same-origin',redirect:'error'});
        expect(new Headers(options?.headers).has('Authorization')).toBe(false);
      }
    } finally {nonce.remove();}
  });
  it('binds a private channel and preserves GraphQL responses',async()=>{
    const {connect,query} = await setup(); const channel = connect();
    channel.port1.postMessage({type:'query',id:1,request});
    await vi.waitFor(()=>expect(channel.port2.messages).toContainEqual({type:'result',id:1,result:{data:{actions:{totalCount:3}},extensions:{complete:true}}}));
    expect(query).toHaveBeenCalledWith(request,expect.any(AbortSignal));
  });
  it('rejects source, origin and token spoofing without granting access',async()=>{
    const {connect,query} = await setup();
    for (const channel of [connect(undefined,{token:'wrong'}),connect(undefined,{},location.origin),connect(undefined,{},'null',{} as Window),connect(undefined,{},'null',null)]) {
      expect(channel.port2.closed).toBe(true);
    }
    const granted=connect(); granted.port1.postMessage({type:'query',id:1,request});
    await vi.waitFor(()=>expect(query).toHaveBeenCalledTimes(1));
    expect(connect().port2.closed).toBe(true);
  });
  it('never registers remote pages, raw files, source documents or a different instance URL',()=>{
    const bridge=createIframeQueryBridge();bridges.push(bridge);
    const context={fileUrl,resource:vi.fn(),isCurrent:()=>true,query:vi.fn(async()=>({data:{}}))};
    for (const [asset,url] of [[undefined,'https://example.com/'],['assets/page.html',`${location.origin}/-/api/instances/work/files/assets/page.html`],[path,`${location.origin}/-/api/instances/other/files/${path}`]]) {
      const frame=webpageFrame('Page',asset);frame.src=url!;
      expect(bridge.register(frame,context)).toBe(false);
    }
    const frame=webpageFrame('Page',path);frame.src=`${location.origin}${fileUrl(path)}`;frame.srcdoc='<h1>Page</h1>';
    expect(bridge.register(frame,context)).toBe(false);
  });
  it.each(['removed','navigated','instance changed','hidden','source changed','sandbox changed'])('revokes access and aborts pending queries when %s',async mode=>{
    let signal!:AbortSignal;
    const query=vi.fn<Query>((_request:typeof request,value:AbortSignal)=>{signal=value;return new Promise<{data:{actions:{totalCount:number}},extensions:{complete:boolean}}>(resolve=>value.addEventListener('abort',()=>resolve({data:{actions:{totalCount:0}},extensions:{complete:false}}),{once:true}));});
    const {frame,connect,deactivate}=await setup(query);const channel=connect();
    channel.port1.postMessage({type:'query',id:1,request});
    await vi.waitFor(()=>expect(query).toHaveBeenCalledTimes(1));
    if(mode==='removed')frame.remove();
    else if(mode==='navigated'){frame.dispatchEvent(new Event('load'));frame.dispatchEvent(new Event('load'));}
    else if(mode==='hidden')frame.hidden=true;
    else if(mode==='source changed')frame.src=`${location.origin}/other.html`;
    else if(mode==='sandbox changed')frame.setAttribute('sandbox','allow-scripts allow-same-origin');
    else {deactivate();channel.port1.postMessage({type:'query',id:2,request});}
    await vi.waitFor(()=>expect(signal.aborted).toBe(true));
    expect(channel.port2.closed).toBe(true);expect(query).toHaveBeenCalledTimes(1);
    expect(channel.port2.messages.some((value:any)=>value.type==='result')).toBe(false);
  });
  it('bounds concurrent queries and honors cancellation',async()=>{
    const signals:AbortSignal[]=[];
    const query=vi.fn<Query>((_request:typeof request,signal:AbortSignal)=>{signals.push(signal);return new Promise<any>(resolve=>signal.addEventListener('abort',()=>resolve({data:null}),{once:true}));});
    const {connect}=await setup(query);const channel=connect();
    for(let id=1;id<=5;id++)channel.port1.postMessage({type:'query',id,request});
    await vi.waitFor(()=>expect(query).toHaveBeenCalledTimes(4));
    expect(channel.port2.messages).toContainEqual({type:'error',id:5,message:'Too many pending requests.'});
    channel.port1.postMessage({type:'cancel',id:1});
    await vi.waitFor(()=>expect(signals[0].aborted).toBe(true));
  });
  it('suspends hidden panel queries and resumes the same channel without reloading its iframe',async()=>{
    let signal!: AbortSignal;
    let finish!: (result: WebQueryResult) => void;
    const query = vi.fn<Query>(async()=>({data:{resumed:true}}));
    query.mockImplementationOnce((_request,value)=>{
      signal = value;
      return new Promise(resolve=>{ finish = resolve; });
    });
    const {frame,bridge,connect} = await setup(query), channel = connect(), source = frame.src;
    channel.port1.postMessage({type:'query',id:1,request});
    await vi.waitFor(()=>expect(query).toHaveBeenCalledTimes(1));

    expect(bridge.setSuspended(frame,true)).toBe(true);
    frame.inert = true;
    await vi.waitFor(()=>expect(signal.aborted).toBe(true));
    expect(channel.port2.closed).toBe(false);
    expect(channel.port2.messages).toContainEqual({type:'error',id:1,message:expect.stringContaining('not visible')});
    channel.port1.postMessage({type:'query',id:2,request});
    await vi.waitFor(()=>expect(channel.port2.messages).toContainEqual({type:'error',id:2,message:expect.stringContaining('not visible')}));
    expect(query).toHaveBeenCalledTimes(1);
    finish({data:{stale:true}});

    frame.inert = false;
    expect(bridge.setSuspended(frame,false)).toBe(true);
    channel.port1.postMessage({type:'query',id:3,request});
    await vi.waitFor(()=>expect(channel.port2.messages).toContainEqual({type:'result',id:3,result:{data:{resumed:true}}}));
    expect(frame.src).toBe(source);
    expect(query).toHaveBeenCalledTimes(2);
    expect(channel.port2.messages.some((value:any)=>value.type==='result' && value.id===1)).toBe(false);
    expect(connect().port2.closed).toBe(true);
  });
  it('allows the initial private handshake while explicitly suspended but grants no query execution',async()=>{
    const {frame,bridge,connect,query} = await setup();
    bridge.setSuspended(frame,true);
    frame.hidden = true;
    const channel = connect();
    expect(channel.port2.messages).toContainEqual({type:'ready'});
    channel.port1.postMessage({type:'query',id:1,request});
    await vi.waitFor(()=>expect(channel.port2.messages).toContainEqual({type:'error',id:1,message:expect.stringContaining('not visible')}));
    expect(query).not.toHaveBeenCalled();
    frame.hidden = false;
    bridge.setSuspended(frame,false);
    channel.port1.postMessage({type:'query',id:2,request});
    await vi.waitFor(()=>expect(query).toHaveBeenCalledOnce());
  });
  it.each(['removed','source changed','sandbox changed','instance changed','cleared'])('still revokes an explicitly suspended grant when %s',async mode=>{
    const {frame,bridge,connect,deactivate,query} = await setup(), channel = connect();
    bridge.setSuspended(frame,true);
    frame.inert = true;
    if (mode==='removed') frame.remove();
    else if (mode==='source changed') frame.src=`${location.origin}/other.html`;
    else if (mode==='sandbox changed') frame.setAttribute('sandbox','allow-scripts allow-same-origin');
    else if (mode==='cleared') bridge.clear();
    else { deactivate(); channel.port1.postMessage({type:'query',id:1,request}); }
    await vi.waitFor(()=>expect(channel.port2.closed).toBe(true));
    expect(bridge.setSuspended(frame,false)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects routing overrides and duplicated request IDs',async()=>{
    const {connect,query}=await setup();const channel=connect();
    channel.port1.postMessage({type:'query',id:1,request:{...request,instance:'other'}});
    await vi.waitFor(()=>expect(channel.port2.messages.some((value:any)=>value.type==='error')).toBe(true));
    expect(query).not.toHaveBeenCalled();
    channel.port1.postMessage({type:'query',id:2,request});channel.port1.postMessage({type:'query',id:2,request});
    await vi.waitFor(()=>expect(channel.port2.closed).toBe(true));
  });
  it('does not grant a prepared frame after its instance context was cleared',()=>{
    const frame=webpageFrame('Page',path);frame.src=`${location.origin}${fileUrl(path)}`;
    const source={} as Window;Object.defineProperty(frame,'contentWindow',{value:source});
    const bridge=createIframeQueryBridge();bridges.push(bridge);
    bridge.register(frame,{fileUrl,resource:vi.fn(),isCurrent:()=>true,query:vi.fn(async()=>({data:{}}))});
    const token=crypto.randomUUID();bridge.clear();document.body.append(frame);
    const channel=new Channel();
    window.dispatchEvent(new MessageEvent('message',{origin:'null',source,data:{type:IFRAME_CONNECT,version:1,token},ports:[channel.port2 as unknown as MessagePort]}));
    expect(channel.port2.closed).toBe(true);
  });
});

async function client() {
  const value=await setup();const events=new Map<string,()=>void>();
  const parent={postMessage:vi.fn((data:unknown,_origin:string,ports:MessagePort[])=>{
    window.dispatchEvent(new MessageEvent('message',{origin:'null',source:value.source,data,ports}));
  })};
  const target={location:new URL('about:srcdoc'),parent,addEventListener:(name:string,callback:()=>void)=>events.set(name,callback)} as unknown as Window;
  pendingClients.push(()=>events.get('pagehide')?.());
  return {...value,api:createIframeQueryClient(target,{token:value.token,parentOrigin:location.origin}),parent,events};
}
describe('iframe SDK',()=>{
  it('returns protected resource bytes through the existing private channel', async () => {
    const {api,resource,parent} = await client();
    const blob = await api.resource('./chart.png');
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('chart bytes');
    expect(resource).toHaveBeenCalledWith('./chart.png', expect.any(AbortSignal));
    await api.query(request.query);
    expect(parent.postMessage).toHaveBeenCalledOnce();
  });

  it('can retry after a temporary panel suspension without opening a new private connection',async()=>{
    const {api,frame,bridge,parent,query} = await client();
    await expect(api.query(request.query)).resolves.toMatchObject({data:{actions:{totalCount:3}}});
    const source = frame.src;
    bridge.setSuspended(frame,true); frame.inert = true;
    await expect(api.query(request.query)).rejects.toThrow('not visible');
    expect(query).toHaveBeenCalledOnce();
    frame.inert = false; bridge.setSuspended(frame,false);
    await expect(api.query(request.query)).resolves.toMatchObject({data:{actions:{totalCount:3}}});
    expect(parent.postMessage).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(2);
    expect(frame.src).toBe(source);
  });
  it('connects once and correlates multiple queries over the private port',async()=>{
    const {api,parent,query}=await client();
    const results=await Promise.all([api.query(request.query),api.query(request.query,{count:2},{operationName:'Dashboard'})]);
    expect(results.every(value=>value.data?.actions)).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[1][0]).toEqual({...request,variables:{count:2},operationName:'Dashboard'});
  });
  it('returns GraphQL errors alongside partial data without rejecting',async()=>{
    const value=await setup(vi.fn<Query>(async()=>({data:{actions:{totalCount:3}},errors:[{message:'Incomplete'}],extensions:{complete:false}})));
    const target={location:new URL('about:srcdoc'),parent:{postMessage:(data:unknown,_origin:string,ports:MessagePort[])=>window.dispatchEvent(new MessageEvent('message',{origin:'null',source:value.source,data,ports}))},addEventListener:()=>{}} as unknown as Window;
    const result=await createIframeQueryClient(target,{token:value.token,parentOrigin:location.origin}).query(request.query);
    expect(result).toMatchObject({data:{actions:{totalCount:3}},errors:[{message:'Incomplete'}],extensions:{complete:false}});
  });
  it('fails clearly outside an artifact preview',async()=>{
    const api=createIframeQueryClient(window);
    await expect(api.query(request.query)).rejects.toThrow('Aside HTML artifact');
  });
  it('rejects invalid input and navigation, and propagates transport errors',async()=>{
    const {api,query,events}=await client();
    await expect(api.query(request.query,{text:'x'.repeat(64*1024)})).rejects.toThrow('oversized');
    query.mockRejectedValueOnce(new Error('Daemon unavailable'));
    await expect(api.query(request.query)).rejects.toThrow('Daemon unavailable');
    events.get('pagehide')!();
    await expect(api.query(request.query)).rejects.toThrow('closed');
  });
  it('times out a missing handshake',async()=>{
    vi.useFakeTimers();
    const target={location:new URL('about:srcdoc'),parent:{postMessage:()=>{}},addEventListener:()=>{}} as unknown as Window;
    const pending=createIframeQueryClient(target,{token:crypto.randomUUID(),parentOrigin:location.origin}).query(request.query);
    const expected=expect(pending).rejects.toThrow('did not accept');
    await vi.advanceTimersByTimeAsync(5000);await expected;
  });
  it('times out requests and sends cancellation to the host',async()=>{
    const {api,query}=await client();
    vi.useFakeTimers();
    let signal!:AbortSignal;
    query.mockImplementationOnce((_request,value)=>{signal=value;return new Promise<any>(resolve=>value.addEventListener('abort',()=>resolve({data:null}),{once:true}));});
    const pending=api.query(request.query);const expected=expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(0);expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WEB_QUERY_TIMEOUT_MS+2000);await expected;
    expect(signal.aborted).toBe(true);
  });
  it('rejects timed out queries even if the cancellation message cannot be sent',async()=>{
    const {api,parent,query}=await client();
    vi.useFakeTimers();
    query.mockImplementationOnce((_request,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve({data:null}),{once:true})));
    const pending=api.query(request.query);const expected=expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(0);
    const hostPort=parent.postMessage.mock.calls[0][2][0] as unknown as Port;
    hostPort.peer.close();
    await vi.advanceTimersByTimeAsync(WEB_QUERY_TIMEOUT_MS+2000);await expected;
  });
});
