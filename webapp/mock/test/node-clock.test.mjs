import { expect, it } from 'vitest';
import { Date as QueryDate, withClock } from '../node-clock.mjs';

it('keeps concurrent asynchronous query clocks independent from each other and the server clock', async () => {
  const firstTime = '2001-02-03T04:05:06Z', secondTime = '2031-06-07T08:09:10Z';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = withClock(firstTime, async () => {
    await gate;
    return { now: QueryDate.now(), constructed: new QueryDate().toISOString(), explicit: new QueryDate('2020-01-01').getUTCFullYear() };
  });
  const second = await withClock(secondTime, async () => {
    await Promise.resolve();
    return QueryDate.now();
  });
  expect(second).toBe(Date.parse(secondTime));
  expect(Math.abs(QueryDate.now() - Date.now())).toBeLessThan(1000);
  release();
  expect(await first).toEqual({ now: Date.parse(firstTime), constructed: '2001-02-03T04:05:06.000Z', explicit: 2020 });
  expect(() => withClock('not a date', () => {})).toThrow('Invalid mock clock.');
});
