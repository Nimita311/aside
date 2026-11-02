import { daemonRequest, instanceLink, type AvailableInstance } from './backend';
import { catalogueRows, instanceIdentity, instanceGroup, calendarTooltip, duplicateTooltip, setInstanceTooltip, CALENDAR_OFF_ICON, WARNING_ICON } from './instance-catalogue';

export class InstanceSwitcher {
  private readonly trigger: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLElement;
  private instances: AvailableInstance[] = [];
  private active: AvailableInstance | null = null;
  private generation = 0;

  constructor(private readonly root: HTMLElement, private readonly select: (instance: AvailableInstance) => void,
    private readonly all: () => void, private readonly request = daemonRequest,
    private readonly discovered?: (instances: AvailableInstance[]) => void) {
    this.trigger = root.querySelector('#btn-instance-switch')!;
    this.label = root.querySelector('#instance-name')!;
    this.menu = root.querySelector('#instance-switch-menu')!;
    this.search = root.querySelector('#instance-switch-search')!;
    this.list = root.querySelector('#instance-switch-list')!;
    this.trigger.addEventListener('click', this.toggle);
    root.querySelector('#btn-close-instance-switch')!.addEventListener('click', this.closeAndFocus);
    root.querySelector('#btn-all-instances')!.addEventListener('click', this.showAll);
    this.search.addEventListener('input', this.renderList);
    root.addEventListener('keydown', this.onKey);
    document.addEventListener('mousedown', this.onOutside);
    root.addEventListener('focusout', this.onFocusOut);
    this.setActive(null);
  }

  setActive(instance: AvailableInstance | null): void {
    this.active = instance;
    const identity = instance ? instanceIdentity(instance, this.instances) : undefined;
    this.label.replaceChildren(identity ?? document.createTextNode('Choose an instance'));
    this.label.title = identity ? [...identity.querySelector('.instance-identity-text')!.children].map(node => node.textContent).join(' ') : 'Choose an instance';
    this.trigger.setAttribute('aria-label', instance ? `Switch instance, current instance ${instance.name || instance.id}` : 'Choose an instance');
  }

  setCatalogue(instances: AvailableInstance[]): void {
    this.instances = instances;
    if (this.active) this.setActive(instances.find(instance => instance.path === this.active!.path) ?? this.active);
    if (!this.menu.hidden) this.renderList();
  }

  close(): void {
    ++this.generation; this.menu.hidden = true; this.trigger.setAttribute('aria-expanded', 'false');
    this.list.removeAttribute('aria-busy');
  }
  private readonly closeAndFocus = () => { this.close(); this.trigger.focus(); };
  private readonly showAll = () => { this.close(); this.all(); };
  private readonly onOutside = (event: MouseEvent) => { if (event.target instanceof Node && !this.root.contains(event.target)) this.close(); };
  private readonly onFocusOut = (event: FocusEvent) => { if (event.relatedTarget instanceof Node && !this.root.contains(event.relatedTarget)) this.close(); };
  private readonly toggle = () => {
    if (!this.menu.hidden) { this.closeAndFocus(); return; }
    this.menu.hidden = false; this.trigger.setAttribute('aria-expanded', 'true'); this.search.value = '';
    this.renderList(); this.search.focus(); void this.refresh();
  };

  private async refresh(): Promise<void> {
    const generation = ++this.generation; this.list.setAttribute('aria-busy', 'true');
    try {
      const instances = await this.request<AvailableInstance[]>('instances');
      if (generation !== this.generation || this.menu.hidden) return;
      this.setCatalogue(instances);
      this.discovered?.(instances);
    } catch {
      if (generation !== this.generation || this.menu.hidden) return;
      this.renderList();
      const retry = document.createElement('button'); retry.className = 'notice-action'; retry.textContent = 'Could not load instances. Retry';
      retry.addEventListener('click', () => void this.refresh()); this.list.append(retry);
    } finally { if (generation === this.generation) this.list.removeAttribute('aria-busy'); }
  }

  private readonly renderList = () => {
    const focused = this.list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.path : undefined;
    const query = this.search.value.trim().toLowerCase();
    const rows = catalogueRows(this.instances);
    const matched = rows.filter(({ instance }) => `${instance.name || ''} ${instance.description || ''} ${instance.id} ${instance.path} ${instance.worktree?.label || ''}`.toLowerCase().includes(query));
    const groups = new Set(matched.map(({ instance }) => instanceGroup(instance)));
    const visible = rows.filter(row => matched.includes(row) || (!row.compact && groups.has(instanceGroup(row.instance))));
    this.list.replaceChildren(...visible.map(({ instance, compact }) => {
      const row = document.createElement('a'); row.className = `instance-menu-item${compact ? ' instance-menu-worktree' : ''}`;
      row.dataset.path = instance.path; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(instance.path === this.active?.path));
      row.setAttribute('aria-label', `Switch to ${instance.name || instance.id}${instance.worktree ? ` ${instance.worktree.label}` : ''} at ${instance.path}`);
      if (!instance.error) row.href = instanceLink(instance); else row.setAttribute('aria-disabled', 'true');
      const check = document.createElement('span'); check.className = 'instance-menu-check'; check.setAttribute('aria-hidden', 'true');
      if (instance.path === this.active?.path) check.textContent = '✓';
      const body = document.createElement('span'); body.className = 'instance-menu-body'; body.append(instanceIdentity(instance, this.instances, compact));
      if (!compact && instance.description) {
        const description = document.createElement('span'); description.className = 'instance-description'; description.textContent = instance.description; body.append(description);
      }
      if (!compact && instance.duplicatePaths?.length) {
        const marker = document.createElement('span'); marker.className = 'instance-duplicate-error'; marker.innerHTML = WARNING_ICON;
        const id = document.createElement('code'); id.textContent = instance.id; marker.append(id);
        setInstanceTooltip(marker, duplicateTooltip(instance, this.instances)); body.append(marker);
      }
      if (instance.error) { const error = document.createElement('span'); error.className = 'instance-error'; error.textContent = instance.error; body.append(error); }
      const status = document.createElement('span'); status.className = 'instance-menu-calendar';
      const calendar = calendarTooltip(instance);
      if (calendar) { status.innerHTML = CALENDAR_OFF_ICON; setInstanceTooltip(status, calendar); }
      const explanation = [instance.duplicatePaths?.length ? duplicateTooltip(instance, this.instances) : '', calendar].filter(Boolean).join(' ');
      if (explanation) setInstanceTooltip(row, explanation);
      row.append(check, body, status);
      row.addEventListener('click', event => {
        if (instance.error) { event.preventDefault(); return; }
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); this.close(); this.select(instance);
      });
      return row;
    }));
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'instance-menu-empty'; empty.textContent = this.instances.length ? 'No matching instances' : 'No instances yet'; this.list.append(empty); }
    if (focused) [...this.list.querySelectorAll<HTMLElement>('[data-path]')].find(row => row.dataset.path === focused)?.focus();
  };

  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !this.menu.hidden) { event.preventDefault(); event.stopPropagation(); this.closeAndFocus(); return; }
    if (event.key === ' ' && !this.menu.hidden && event.target instanceof HTMLAnchorElement && this.list.contains(event.target)) {
      event.preventDefault(); event.target.click(); return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (this.menu.hidden) { if (event.target !== this.trigger) return; this.toggle(); }
    event.preventDefault();
    const options = [...this.list.querySelectorAll<HTMLAnchorElement>('a[href]')];
    const index = options.indexOf(document.activeElement as HTMLAnchorElement), step = event.key === 'ArrowDown' ? 1 : -1;
    options[index < 0 ? (step > 0 ? 0 : options.length - 1) : (index + step + options.length) % options.length]?.focus();
  };

  dispose(): void {
    this.close(); this.trigger.removeEventListener('click', this.toggle);
    this.root.querySelector('#btn-close-instance-switch')!.removeEventListener('click', this.closeAndFocus);
    this.root.querySelector('#btn-all-instances')!.removeEventListener('click', this.showAll);
    this.search.removeEventListener('input', this.renderList); this.root.removeEventListener('keydown', this.onKey);
    document.removeEventListener('mousedown', this.onOutside); this.root.removeEventListener('focusout', this.onFocusOut);
  }
}
