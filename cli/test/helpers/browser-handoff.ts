import { runInNewContext } from 'node:vm';

/** Execute the daemon's real completion script with a browser profile's storage. */
export async function openHandoffBridge(origin: string, html: string, savedToken: string | null = null) {
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Missing browser handoff script.');
  const browser = {token: savedToken, writes: 0, destination: undefined as string | undefined};
  const status = {textContent: ''};
  await runInNewContext(script, {
    localStorage: {
      getItem: (key: string) => key === 'aside.webToken' ? browser.token : null,
      setItem: (key: string, value: string) => {
        if (key !== 'aside.webToken') throw new Error('Unexpected browser storage key.');
        browser.token = value; browser.writes++;
      },
    },
    location: {replace: (route: string) => { browser.destination = route; }},
    document: {getElementById: () => status},
    URLSearchParams, Headers,
    fetch: (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set('Origin', origin);
      return fetch(new URL(url, origin), {...init, headers});
    },
  });
  return {...browser, error: status.textContent};
}
