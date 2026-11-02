'use strict';
const $ = id => document.getElementById(id);
const statuses = ['BACKLOG', 'SCHEDULED', 'DONE', 'CANCELLED'];
const labels = {BACKLOG:'Backlog', SCHEDULED:'Scheduled', DONE:'Done', CANCELLED:'Cancelled'};
const colors = {BACKLOG:'#dfad64', SCHEDULED:'#6b8da1', DONE:'#456752', CANCELLED:'#bd8a7d'};
let actions = [];
function render() {
  const selected = $('status').value;
  const counts = Object.fromEntries(statuses.map(status => [status, actions.filter(action => action.status === status).length]));
  $('total').textContent = actions.length;
  $('scheduled').textContent = counts.SCHEDULED;
  $('done').textContent = counts.DONE;
  const maximum = Math.max(...Object.values(counts), 1);
  const chart = $('chart');
  const focusedStatus = chart.contains(document.activeElement) ? document.activeElement?.getAttribute('data-status') : null;
  chart.replaceChildren();
  const legend = $('legend'); legend.replaceChildren();
  for (const status of statuses) {
    const bar = document.createElement('button'); bar.type = 'button'; bar.className = 'chart-bar';
    bar.dataset.status = status;
    bar.style.height = `${Math.max(5, counts[status] / maximum * 116)}px`; bar.style.background = colors[status];
    bar.setAttribute('aria-label', `${labels[status]}: ${counts[status]} actions. Filter list.`);
    bar.setAttribute('aria-pressed', String(selected === status));
    const number = document.createElement('span'); number.textContent = counts[status]; bar.append(number);
    bar.onclick = () => { $('status').value = selected === status ? '' : status; render(); };
    chart.append(bar);
    const key = document.createElement('span'); key.style.setProperty('--swatch', colors[status]); key.textContent = labels[status]; legend.append(key);
  }
  if (focusedStatus) chart.querySelector(`[data-status="${focusedStatus}"]`)?.focus({preventScroll: true});
  const filtered = selected ? actions.filter(action => action.status === selected) : actions;
  const rows = $('tasks'); rows.replaceChildren();
  for (const action of filtered) {
    const row = document.createElement('tr');
    const name = document.createElement('td'); name.textContent = action.name;
    const state = document.createElement('td'), badge = document.createElement('span');
    badge.className = `badge ${action.status.toLowerCase()}`; badge.textContent = labels[action.status] || action.status; state.append(badge);
    const date = document.createElement('td'); date.textContent = action.scheduled ? action.scheduled.replace('T', ' · ') : '—';
    row.append(name, state, date); rows.append(row);
  }
  if (!filtered.length) {
    const row = document.createElement('tr'), empty = document.createElement('td'); empty.colSpan = 3;
    empty.textContent = 'No actions in this view. Try another status.'; row.append(empty); rows.append(row);
  }
  $('count').textContent = `${filtered.length} of ${actions.length} actions${selected ? ` · ${labels[selected]}` : ''}`;
}
async function load() {
  try {
    if (!window.aside) throw new Error('Open this HTML file inside its Aside artifact preview to connect.');
    const result = await aside.query(`query AuroraOverview {
      actions(where: {recurrenceExists: false}, limit: 100) { totalCount nodes { name status scheduled } }
      projects(where: {status: OPEN}, limit: 1) { totalCount }
    }`, undefined, {operationName: 'AuroraOverview'});
    if (!result.data?.actions) throw new Error((result.errors || []).map(error => error.message).join(' ') || 'The action response is unavailable.');
    actions = result.data.actions.nodes;
    $('projects').textContent = result.data.projects?.totalCount ?? '—';
    $('connection').textContent = 'Connected to the fictional local workspace';
    if (result.errors?.length || result.extensions?.complete === false) {
      $('notice').hidden = false;
      $('notice').textContent = 'Some demo data may be incomplete. ' + (result.errors || []).map(error => error.message).join(' ');
    }
    render();
  } catch (error) {
    $('connection').textContent = 'The local workspace is unavailable';
    $('notice').hidden = false; $('notice').textContent = error instanceof Error ? error.message : String(error);
    $('tasks').replaceChildren(); $('count').textContent = 'No actions loaded';
  }
}
$('status').addEventListener('change', render);
$('reset').addEventListener('click', () => { $('status').value = ''; render(); });
void load();
