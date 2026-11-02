// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIframeQueryBridge } from '../src/iframe-bridge';
import { createIframeQueryClient } from '../src/iframe-sdk';
import { IFRAME_CONNECT, IFRAME_TOKEN } from '../src/iframe-protocol';
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
  (window as unknown as {happyDOM:{settings:{navigation:{disableChildFrameNavigation:boolean}}}}).happyDOM.settings.navigation.disableChildFrameNavigation = true;
});
afterEach(()=>{pendingClients.splice(0).forEach(close=>close());bridges.splice(0).forEach(bridge=>bridge.dispose());document.body.replaceChildren();vi.useRealTimers();vi.unstubAllGlobals();});

function setup(query = vi.fn<Query>(async()=>({data:{actions:{totalCount:3}},extensions:{complete:true}}))) {
  const frame = webpageFrame('Dashboard', path);
  frame.src = `${location.origin}${fileUrl(path)}`;
  const source = {} as Window;
  Object.defineProperty(frame,'contentWindow',{value:source});
  const bridge = createIframeQueryBridge(); bridges.push(bridge);
  let active = true;
  const context = {instance:'work',fileUrl,isCurrent:()=>active,query};
  expect(bridge.register(frame,context)).toBe(true);
  document.body.append(frame);
  const token = new URL(frame.src).hash.split(`${IFRAME_TOKEN}=`)[1];
  const connect = (channel = new Channel(), overrides: Record<string,unknown> = {}, origin = 'null', sender: Window | null = source) => {
    window.dispatchEvent(new MessageEvent('message',{origin, source:sender, data:{type:IFRAME_CONNECT,version:1,token,...overrides}, ports:[channel.port2 as unknown as MessagePort]}));
    return channel;
  };
  return {frame,bridge,query,source,context,connect,deactivate:()=>{active=false;}};
}

describe('iframe query connections',()=>{
  it('binds a private channel and preserves GraphQL responses',async()=>{
    const {connect,query} = setup(); const channel = connect();
    channel.port1.postMessage({type:'query',id:1,request});
    await vi.waitFor(()=>expect(channel.port2.messages).toContainEqual({type:'result',id:1,result:{data:{actions:{totalCount:3}},extensions:{complete:true}}}));
    expect(query).toHaveBeenCalledWith(request,expect.any(AbortSignal));
  });
  it('rejects source, origin and token spoofing without granting access',async()=>{
    const {connect,query} = setup();
    for (const channel of [connect(undefined,{token:'wrong'}),connect(undefined,{},location.origin),connect(undefined,{},'null',{} as Window),connect(undefined,{},'null',null)]) {
      expect(channel.port2.closed).toBe(true);
    }
    const granted=connect(); granted.port1.postMessage({type:'query',id:1,request});
    await vi.waitFor(()=>expect(query).toHaveBeenCalledTimes(1));
    expect(connect().port2.closed).toBe(true);
  });
  it('never registers remote pages, raw files, source documents or a different instance URL',()=>{
    const bridge=createIframeQueryBridge();bridges.push(bridge);
    const context={instance:'work',fileUrl,isCurrent:()=>true,query:vi.fn(async()=>({data:{}}))};
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
    const {frame,connect,deactivate}=setup(query);const channel=connect();
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
    const {connect}=setup(query);const channel=connect();
    for(let id=1;id<=5;id++)channel.port1.postMessage({type:'query',id,request});
    await vi.waitFor(()=>expect(query).toHaveBeenCalledTimes(4));
    expect(channel.port2.messages).toContainEqual({type:'error',id:5,message:'Too many pending queries. Wait for a query to finish.'});
    channel.port1.postMessage({type:'cancel',id:1});
    await vi.waitFor(()=>expect(signals[0].aborted).toBe(true));
  });
  it('rejects routing overrides and duplicated request IDs',async()=>{
    const {connect,query}=setup();const channel=connect();
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
    bridge.register(frame,{instance:'work',fileUrl,isCurrent:()=>true,query:vi.fn(async()=>({data:{}}))});
    const token=new URL(frame.src).hash.split(`${IFRAME_TOKEN}=`)[1];bridge.clear();document.body.append(frame);
    const channel=new Channel();
    window.dispatchEvent(new MessageEvent('message',{origin:'null',source,data:{type:IFRAME_CONNECT,version:1,token},ports:[channel.port2 as unknown as MessagePort]}));
    expect(channel.port2.closed).toBe(true);
  });
});

function client() {
  const value=setup();const events=new Map<string,()=>void>();
  const parent={postMessage:vi.fn((data:unknown,_origin:string,ports:MessagePort[])=>{
    window.dispatchEvent(new MessageEvent('message',{origin:'null',source:value.source,data,ports}));
  })};
  const target={location:new URL(value.frame.src),parent,addEventListener:(name:string,callback:()=>void)=>events.set(name,callback)} as unknown as Window;
  pendingClients.push(()=>events.get('pagehide')?.());
  return {...value,api:createIframeQueryClient(target),parent,events};
}
describe('iframe SDK',()=>{
  it('connects once and correlates multiple queries over the private port',async()=>{
    const {api,parent,query}=client();
    const results=await Promise.all([api.query(request.query),api.query(request.query,{count:2},{operationName:'Dashboard'})]);
    expect(results.every(value=>value.data?.actions)).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[1][0]).toEqual({...request,variables:{count:2},operationName:'Dashboard'});
  });
  it('returns GraphQL errors alongside partial data without rejecting',async()=>{
    const value=setup(vi.fn<Query>(async()=>({data:{actions:{totalCount:3}},errors:[{message:'Incomplete'}],extensions:{complete:false}})));
    const target={location:new URL(value.frame.src),parent:{postMessage:(data:unknown,_origin:string,ports:MessagePort[])=>window.dispatchEvent(new MessageEvent('message',{origin:'null',source:value.source,data,ports}))},addEventListener:()=>{}} as unknown as Window;
    const result=await createIframeQueryClient(target).query(request.query);
    expect(result).toMatchObject({data:{actions:{totalCount:3}},errors:[{message:'Incomplete'}],extensions:{complete:false}});
  });
  it('fails clearly outside an artifact preview',async()=>{
    const api=createIframeQueryClient(window);
    await expect(api.query(request.query)).rejects.toThrow('local Aside HTML artifact');
  });
  it('rejects invalid input and navigation, and propagates transport errors',async()=>{
    const {api,query,events}=client();
    await expect(api.query(request.query,{text:'x'.repeat(64*1024)})).rejects.toThrow('oversized');
    query.mockRejectedValueOnce(new Error('Daemon unavailable'));
    await expect(api.query(request.query)).rejects.toThrow('Daemon unavailable');
    events.get('pagehide')!();
    await expect(api.query(request.query)).rejects.toThrow('closed');
  });
  it('times out a missing handshake',async()=>{
    vi.useFakeTimers();
    const target={location:new URL(`${location.origin}/page.html#${IFRAME_TOKEN}=00000000-0000-0000-0000-000000000000`),parent:{postMessage:()=>{}},addEventListener:()=>{}} as unknown as Window;
    const pending=createIframeQueryClient(target).query(request.query);
    const expected=expect(pending).rejects.toThrow('did not accept');
    await vi.advanceTimersByTimeAsync(5000);await expected;
  });
  it('times out requests and sends cancellation to the host',async()=>{
    vi.useFakeTimers();
    const {api,query}=client();
    let signal!:AbortSignal;
    query.mockImplementationOnce((_request,value)=>{signal=value;return new Promise<any>(resolve=>value.addEventListener('abort',()=>resolve({data:null}),{once:true}));});
    const pending=api.query(request.query);const expected=expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(0);expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WEB_QUERY_TIMEOUT_MS+2000);await expected;
    expect(signal.aborted).toBe(true);
  });
  it('rejects timed out queries even if the cancellation message cannot be sent',async()=>{
    vi.useFakeTimers();
    const {api,parent,query}=client();
    query.mockImplementationOnce((_request,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve({data:null}),{once:true})));
    const pending=api.query(request.query);const expected=expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(0);
    const hostPort=parent.postMessage.mock.calls[0][2][0] as unknown as Port;
    hostPort.peer.close();
    await vi.advanceTimersByTimeAsync(WEB_QUERY_TIMEOUT_MS+2000);await expected;
  });
});
