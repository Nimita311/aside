// Independent of file polling: unchanged records cross deadlines and local
// day boundaries. Hidden tabs catch up once rather than replaying ticks.
export function startDisplayClock(repaint: () => void, minuteMs: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  function schedule(): void {
    clear();
    if (stopped || document.hidden) return;
    timer = setTimeout(() => { if (stopped || document.hidden) return; repaint(); schedule(); }, minuteMs - Date.now() % minuteMs);
  }
  function foreground(): void {
    if (stopped || document.hidden) { clear(); return; }
    repaint(); schedule();
  }
  document.addEventListener('visibilitychange', foreground);
  window.addEventListener('focus', foreground);
  schedule();
  return () => { stopped = true; clear(); document.removeEventListener('visibilitychange', foreground); window.removeEventListener('focus', foreground); };
}
