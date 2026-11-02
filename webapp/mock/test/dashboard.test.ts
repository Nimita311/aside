import { readFile } from 'node:fs/promises';
import { Window, type HTMLButtonElement, type HTMLSelectElement } from 'happy-dom';
import { expect, it, vi } from 'vitest';

it('keeps chart keyboard focus on its status after filtering without taking focus from other controls', async () => {
  const preview = new Window({ url: 'http://localhost/' });
  preview.document.body.innerHTML = `
    <select id="status"><option value="">All</option><option value="BACKLOG">Backlog</option><option value="DONE">Done</option></select>
    <button id="reset">Reset</button><div id="chart"></div><div id="legend"></div>
    <table><tbody id="tasks"></tbody></table>
    ${['total', 'scheduled', 'done', 'projects', 'connection', 'notice', 'count'].map(id => `<span id="${id}"></span>`).join('')}`;
  Object.assign(preview, { aside: { query: async () => ({ data: {
    actions: { nodes: [{ name: 'Write the brief', status: 'BACKLOG' }, { name: 'Prepare the kit', status: 'DONE' }] },
    projects: { totalCount: 2 },
  } }) } });
  try {
    preview.eval(await readFile(new URL('../fixtures/showcase/artifacts/2026/2026-10-12-dashboard/dashboard.js', import.meta.url), 'utf8'));
    await vi.waitFor(() => expect(preview.document.querySelectorAll('.chart-bar')).toHaveLength(4));
    const backlog = preview.document.querySelector<HTMLButtonElement>('[data-status="BACKLOG"]')!;
    backlog.focus();
    backlog.click();
    const replacement = preview.document.querySelector<HTMLButtonElement>('[data-status="BACKLOG"]')!;
    expect(preview.document.activeElement).toBe(replacement);
    expect(replacement.getAttribute('aria-pressed')).toBe('true');
    expect(preview.document.querySelector('#count')?.textContent).toBe('1 of 2 actions · Backlog');

    const filter = preview.document.querySelector<HTMLSelectElement>('#status')!;
    filter.focus(); filter.value = 'DONE'; filter.dispatchEvent(new preview.Event('change'));
    expect(preview.document.activeElement).toBe(filter);
    expect(preview.document.querySelector('#count')?.textContent).toBe('1 of 2 actions · Done');
  } finally { await preview.happyDOM.close(); }
});
