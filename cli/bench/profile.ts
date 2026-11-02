import { Session } from 'node:inspector/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProfileResult { path: string; selfMs: { frame: string; ms: number }[] }
export async function startProfile(): Promise<(path: string) => Promise<ProfileResult>> {
  const session = new Session(); session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 500 });
    await session.post('Profiler.start');
  } catch (error) { session.disconnect(); throw error; }
  return async (path: string) => {
    try {
      const { profile } = await session.post('Profiler.stop');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(profile));
      const frames = new Map(profile.nodes.map(n => [n.id, n.callFrame]));
      const self = new Map<string, number>();
      for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
        const frame = frames.get(profile.samples![i])!;
        const key = `${frame.functionName || '(anonymous)'} · ${frame.url || '(runtime)'}`;
        self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
      }
      return { path, selfMs: [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([frame, ms]) => ({ frame, ms })) };
    } finally { session.disconnect(); }
  };
}
