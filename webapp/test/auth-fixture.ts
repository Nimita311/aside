import { vi } from 'vitest';

export class EventStream {
  static streams: EventStream[] = [];
  readonly response: Response;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private ended = false;
  close = vi.fn(() => { this.ended = true; });
  constructor(readonly url: string, signal?: AbortSignal | null) {
    const body = new ReadableStream<Uint8Array>({
      start: controller => { this.controller = controller; },
      cancel: () => { this.close(); },
    });
    this.response = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    signal?.addEventListener('abort', () => {
      if (!this.ended) { this.close(); this.controller.error(new DOMException('Aborted', 'AbortError')); }
    }, { once: true });
    EventStream.streams.push(this);
  }
  send(data: string, event?: string): void {
    if (!this.ended) this.controller.enqueue(new TextEncoder().encode(`${event ? `event: ${event}\n` : ''}data: ${data}\n\n`));
  }
  fail(): void { if (!this.ended) { this.ended = true; this.controller.error(new Error('Disconnected')); } }
}

/** App operation fixtures share the real authenticated fetch event transport. */
export function stubBrowserFetch(request: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if ((url.endsWith('/control') || url.endsWith('/watch')) && init?.method !== 'POST') {
      return Promise.resolve(new EventStream(url, init?.signal).response);
    }
    if (url.endsWith('/access')) return Promise.resolve(Response.json({ fileBase: `/-/files/00000000-0000-4000-8000-000000000001/${url.split('/')[4]}`, fileKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }));
    return Promise.resolve(request(url, init));
  });
}
