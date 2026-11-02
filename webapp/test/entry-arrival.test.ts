// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { animateEntryArrival, setSlideMs } from '../src/flip';

afterEach(() => { setSlideMs(200); vi.restoreAllMocks(); document.body.replaceChildren(); });

function setup(reduced = false) {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: reduced } as MediaQueryList);
  const pane = document.createElement('div'); document.body.append(pane);
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 500, 500));
  const flights: { frames: Keyframe[]; options: KeyframeAnimationOptions; cancel: () => void; finish: () => void }[] = [];
  for (const [index, top] of [20, 140, 300, 650].entries()) {
    const card = document.createElement('article'); card.className = 'entry-card'; card.dataset.entryId = String(index);
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 500, 100));
    Object.defineProperty(card, 'animate', { value: (frames: Keyframe[], options: KeyframeAnimationOptions) => {
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const cancel = vi.fn(finish);
      flights.push({ frames, options, cancel, finish });
      return { finished, cancel };
    } });
    pane.append(card);
  }
  return { pane, flights };
}

describe('initial entry entrance', () => {
  it('raises visible cards from below, staggers them and releases animation effects', async () => {
    const { pane, flights } = setup(); const arrival = animateEntryArrival(pane);
    expect(flights).toHaveLength(3); // Includes the partially visible first card.
    expect(flights.map(flight => flight.options.delay)).toEqual([0, 35, 70]);
    expect(flights[0].frames).toEqual([{ transform: 'translateY(40px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }]);
    flights.forEach(flight => flight.finish()); await arrival.finished;
    flights.forEach(flight => expect(flight.cancel).toHaveBeenCalledOnce());
  });

  it('cancels a superseded entrance and honors animation speed', async () => {
    setSlideMs(400); const { pane, flights } = setup(); const arrival = animateEntryArrival(pane);
    expect(flights[0].options.duration).toBe(600);
    arrival.cancel(); await arrival.finished;
    flights.forEach(flight => expect(flight.cancel).toHaveBeenCalled());
  });

  it.each(['reduced', 'off'])('reveals entries immediately when motion is %s', async mode => {
    const { pane, flights } = setup(mode === 'reduced'); if (mode === 'off') setSlideMs(0);
    await animateEntryArrival(pane).finished; expect(flights).toHaveLength(0);
    expect(pane.children).toHaveLength(4);
  });
});
