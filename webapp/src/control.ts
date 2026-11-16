// Each stream keeps one browser tab alive. A chooser has no selected instance;
// a selected tab keeps only its own instance loaded and receives its show calls.
import { webFetch, connectEvents } from './connection';
export function connectControl(instanceId: string | null, onNavigate: (route: string) => void,
  onConnection: (connected: boolean, retrying?: boolean) => void): () => void {
  const endpoint = instanceId === null ? '/-/api/control' : `/-/api/instances/${encodeURIComponent(instanceId)}/control`;
  let active = true;
  let tabId: number | null = null;
  const reportFocus = () => {
    if (tabId === null || !document.hasFocus()) return;
    void webFetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ focus: tabId }),
    }).catch(() => { if (active) onConnection(false); });
  };
  const stopEvents = connectEvents(endpoint, {
    connection: (connected, retrying) => { if (active) { if (!connected) tabId = null; onConnection(connected, retrying); } },
    message: data => {
    if (!active) return;
    let msg: { tab?: unknown; navigate?: unknown };
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg.tab === 'number') { tabId = msg.tab; reportFocus(); }
    else if (typeof msg.navigate === 'string') onNavigate(msg.navigate);
    },
  });
  window.addEventListener('focus', reportFocus);
  document.addEventListener('visibilitychange', reportFocus);
  return () => {
    active = false;
    stopEvents();
    window.removeEventListener('focus', reportFocus);
    document.removeEventListener('visibilitychange', reportFocus);
  };
}
