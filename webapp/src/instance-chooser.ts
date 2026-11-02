import { daemonRequest, instanceLink, type AvailableInstance } from './backend';
import { showDelayedLoading, delayLoading } from './notice';
import { showActionFailure } from './toast';
import { catalogueRows, instanceIdentity, instanceGroup, calendarTooltip, duplicateTooltip, setInstanceTooltip, CALENDAR_OFF_ICON, WARNING_ICON } from './instance-catalogue';
import { formatDate, formatClock } from './date-display';
import { renderFactsLine, formatStamp, type RenderOptions } from './render';
import { localDateStamp } from './date-reference';

const hasDuplicateId = (instance: AvailableInstance): boolean => !!instance.duplicatePaths?.length;

// The chooser manages catalogue entries; removing one never deletes its files.
export class InstanceChooser {
  private readonly list: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly add: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly pathInput: HTMLInputElement;
  private readonly addError: HTMLElement;
  private readonly browse: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private generation = 0;
  private mutating = false;
  private refreshing = false;
  private opening = false;
  private redrawPending = false;
  private openingPath: string | undefined;
  private cancelOpening: (() => void) | undefined;
  private instances: AvailableInstance[] = [];

  constructor(private readonly root: HTMLElement, private readonly request = daemonRequest,
    private readonly openInstance?: (instance: AvailableInstance) => void,
    private readonly options: { renderOptions?: () => RenderOptions; onCatalogue?: (instances: AvailableInstance[]) => void; onStatus?: (instance: AvailableInstance) => void } = {}) {
    this.list = root.querySelector('#instance-list')!;
    this.notice = root.querySelector('#instance-notice')!;
    this.add = root.querySelector('#btn-add-instance')!;
    this.retry = root.querySelector('#btn-retry-instances')!;
    this.form = root.querySelector('#instance-add-form')!;
    this.pathInput = root.querySelector('#instance-add-path')!;
    this.addError = root.querySelector('#instance-add-error')!;
    this.browse = root.querySelector('#btn-browse-instance')!;
    this.cancel = root.querySelector('#btn-cancel-add-instance')!;
    this.add.addEventListener('click', this.onAdd);
    this.form.addEventListener('submit', this.onSubmit);
    this.form.addEventListener('keydown', this.onFormKey);
    this.pathInput.addEventListener('input', this.clearAddError);
    this.browse.addEventListener('click', this.onBrowse);
    this.cancel.addEventListener('click', this.onCancel);
    this.retry.addEventListener('click', this.onRetry);
    window.addEventListener('focus', this.onRefresh);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private readonly onRefresh = () => { void this.refresh(); };
  private readonly onRetry = () => { void this.refresh(true); };
  private readonly onVisible = () => { if (document.visibilityState === 'visible') void this.refresh(); };
  private readonly onAdd = () => { this.setAddOpen(this.form.hidden); };
  private readonly onCancel = () => { this.setAddOpen(false); };
  private readonly onFormKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !this.mutating) { event.preventDefault(); event.stopPropagation(); this.setAddOpen(false); }
  };
  private readonly clearAddError = () => { this.addError.textContent = ''; this.pathInput.removeAttribute('aria-invalid'); };
  private readonly onBrowse = () => { void this.pickFolder(); };
  private async pickFolder(): Promise<void> {
    let picked = false;
    await this.mutate(async () => {
      const { path } = await this.request<{ path: string | null }>('instances/pick', { kind: 'directory' });
      if (path !== null && !this.root.hidden) { this.pathInput.value = path; this.clearAddError(); picked = true; }
      return null;
    }, 'Could not choose a folder. Enter its full path and try again.');
    if (picked && !this.root.hidden) this.pathInput.focus();
  }
  private readonly onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    const path = this.pathInput.value.trim();
    if (!path) {
      this.addError.textContent = 'Enter an instance path or choose a folder.';
      this.pathInput.setAttribute('aria-invalid', 'true');
      this.pathInput.focus();
      return;
    }
    void this.register(path);
  };

  private setAddOpen(open: boolean): void {
    if (this.mutating) return;
    const restoreFocus = this.form.contains(document.activeElement) || document.activeElement === document.body;
    this.form.hidden = !open;
    this.add.hidden = open;
    this.add.setAttribute('aria-expanded', String(open));
    this.clearAddError();
    if (open) this.pathInput.focus();
    else {
      this.pathInput.value = '';
      if (restoreFocus) this.add.focus();
    }
  }

  private async register(path: string): Promise<void> {
    this.clearAddError();
    const added = await this.mutate(async () => {
      const { instance } = await this.request<{ instance: AvailableInstance | null }>('instances/register', { path });
      return instance === null ? null : this.request<AvailableInstance[]>('instances');
    }, 'Could not add this path. Enter the full path to an Aside folder or its aside.md file.');
    if (this.root.hidden) return;
    if (added) this.setAddOpen(false);
    else {
      this.pathInput.setAttribute('aria-invalid', 'true');
      this.pathInput.focus();
    }
  }

  dispose(): void {
    this.resetOpening();
    ++this.generation;
    this.add.removeEventListener('click', this.onAdd);
    this.form.removeEventListener('submit', this.onSubmit);
    this.form.removeEventListener('keydown', this.onFormKey);
    this.pathInput.removeEventListener('input', this.clearAddError);
    this.browse.removeEventListener('click', this.onBrowse);
    this.cancel.removeEventListener('click', this.onCancel);
    this.retry.removeEventListener('click', this.onRetry);
    window.removeEventListener('focus', this.onRefresh);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  setCatalogue(instances: AvailableInstance[]): void {
    if (this.mutating || this.opening) return;
    // Switcher discovery supersedes any older chooser request still in flight.
    ++this.generation;
    this.refreshing = false;
    this.list.removeAttribute('aria-busy');
    this.render(instances);
  }

  async refresh(userInitiated = false): Promise<void> {
    if (this.root.hidden || this.mutating || this.opening) return;
    const generation = ++this.generation;
    this.refreshing = true;
    this.list.setAttribute('aria-busy', 'true');
    const cancelLoading = !this.list.children.length
      ? showDelayedLoading(this.notice, 'Loading instances…', () => generation === this.generation && !this.root.hidden)
      : () => {};
    try {
      const instances = await this.request<AvailableInstance[]>('instances');
      if (generation !== this.generation || this.root.hidden) return;
      this.render(instances);
    } catch {
      if (generation !== this.generation || this.root.hidden) return;
      this.retry.hidden = false;
      this.notice.replaceChildren(this.retry);
      if (userInitiated) showActionFailure('Could not load your instances. Try again.');
    } finally {
      cancelLoading();
      if (generation === this.generation) {
        this.refreshing = false;
        this.list.removeAttribute('aria-busy');
      }
    }
  }

  resetOpening(): void {
    this.cancelOpening?.();
    this.cancelOpening = undefined;
    this.opening = false;
    this.openingPath = undefined;
    this.setBusy(false);
    this.list.querySelectorAll('.instance-loading').forEach(spinner => spinner.remove());
    this.list.querySelectorAll('[aria-busy]').forEach(row => row.removeAttribute('aria-busy'));
    if (this.redrawPending && !this.mutating) this.redraw();
  }

  showOpening(instance: AvailableInstance): { finish: () => void; fail: (error: unknown) => void } {
    const row = [...this.list.children].find(row => (row as HTMLElement).dataset.path === instance.path);
    this.resetOpening();
    ++this.generation;
    this.refreshing = false;
    this.opening = true;
    this.openingPath = instance.path;
    this.setBusy(true);
    row?.setAttribute('aria-busy', 'true');
    const name = row?.querySelector('strong');
    const cancel = name ? delayLoading(() => {
      const spinner = document.createElement('span');
      spinner.className = 'instance-loading';
      spinner.setAttribute('role', 'status');
      spinner.setAttribute('aria-atomic', 'true');
      const message = document.createElement('span');
      message.className = 'instance-loading-message';
      spinner.append(message);
      name.append(spinner);
      message.textContent = 'Loading instance…';
    }, () => this.opening && !this.root.hidden) : () => {};
    this.cancelOpening = cancel;
    const finish = () => { if (this.cancelOpening === cancel) this.resetOpening(); };
    return { finish, fail: () => {
      if (this.cancelOpening !== cancel) return;
      finish();
      if (!this.root.hidden) showActionFailure('Could not open this instance. Click its card to retry.');
    } };
  }

  private async mutate(operation: () => Promise<AvailableInstance[] | null>, failure: string): Promise<boolean> {
    if (this.mutating || this.opening || this.root.hidden) return false;
    this.mutating = true;
    const interruptedRefresh = this.refreshing;
    this.refreshing = false;
    const generation = ++this.generation;
    const focus = this.focusTarget();
    const launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.setBusy(true);
    try {
      let instances = await operation();
      const changed = instances !== null;
      if (generation !== this.generation || this.root.hidden) return false;
      // Cancelling the file dialog leaves the list and its message alone.
      // Finish any catalogue load that the mutation superseded.
      if (instances === null && interruptedRefresh) {
        instances = await this.request<AvailableInstance[]>('instances');
        if (generation !== this.generation || this.root.hidden) return false;
      }
      if (instances !== null) this.render(instances, focus);
      return changed;
    } catch {
      if (generation === this.generation && !this.root.hidden) {
        showActionFailure(failure);
      }
      return false;
    } finally {
      this.mutating = false;
      this.setBusy(false);
      if (this.redrawPending) this.redraw();
      if (generation === this.generation && !this.root.hidden && document.activeElement === document.body) {
        (focus ? this.focusElement(focus) : launcher?.isConnected ? launcher : this.add).focus();
      }
    }
  }

  private setBusy(busy: boolean): void {
    this.root.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy; });
    this.pathInput.disabled = busy;
    if (busy) this.list.setAttribute('aria-busy', 'true');
    else this.list.removeAttribute('aria-busy');
  }

  private focusTarget() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.list.contains(active)) return null;
    const row = active.closest<HTMLElement>('.instance-row')!;
    const control = ['instance-remove', 'instance-calendar-icon', 'instance-duplicate-error'].find(name => active.classList.contains(name));
    return { path: row.dataset.path, index: [...this.list.children].indexOf(row), selector: control ? `.${control}` : 'a.instance-open' };
  }

  private focusElement(focus: NonNullable<ReturnType<InstanceChooser['focusTarget']>>): HTMLElement {
    const rows = [...this.list.children] as HTMLElement[];
    const row = rows.find(row => row.dataset.path === focus.path) ?? rows[Math.min(focus.index, rows.length - 1)];
    return row?.querySelector<HTMLElement>(focus.selector) ?? row?.querySelector<HTMLElement>('a.instance-open, .instance-remove') ?? this.add;
  }

  redraw(): void {
    if (this.mutating || this.opening) { this.redrawPending = true; return; }
    this.redrawPending = false;
    this.render(this.instances);
  }

  private render(instances: AvailableInstance[], fallbackFocus = this.focusTarget()): void {
    this.instances = instances;
    this.options.onCatalogue?.(instances);
    const focus = this.focusTarget() ?? fallbackFocus;
    const restoreFocus = this.list.contains(document.activeElement) || (focus !== null && document.activeElement === document.body);
    const rows = catalogueRows(instances).map(({ instance, compact }) => {
      const duplicate = hasDuplicateId(instance);
      const row = document.createElement('li');
      row.className = 'instance-row';
      if (compact) row.classList.add('instance-row-worktree');
      row.dataset.path = instance.path;
      const content = document.createElement(instance.error ? 'div' : 'a');
      content.className = 'instance-open';
      if (content instanceof HTMLAnchorElement) {
        content.href = instanceLink(instance);
        content.addEventListener('click', event => {
          if (!this.openInstance || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          if (!this.mutating && this.openingPath !== instance.path) this.openInstance(instance);
        });
      }
      const label = instance.name || instance.id || 'Unavailable instance';
      content.append(instanceIdentity(instance, instances, compact));
      if (!compact && instance.description) {
        const description = document.createElement('span');
        description.className = 'instance-description';
        description.textContent = instance.description;
        content.append(description);
      }
      if (instance.error) {
        const error = document.createElement('span');
        error.className = 'instance-error';
        error.textContent = instance.error;
        content.append(error);
      }
      const body = document.createElement('div'); body.className = 'instance-card-body'; body.append(content);
      const opts = this.options.renderOptions?.();
      const facts = instance.summary && opts ? renderFactsLine(instance.summary, instance.summary.latest, opts) : document.createElement('div');
      facts.classList.add('summary-facts');
      if (duplicate && !compact) {
        const warning = document.createElement('button'); warning.type = 'button'; warning.className = 'instance-duplicate-error';
        warning.innerHTML = WARNING_ICON;
        const id = document.createElement('code'); id.textContent = instance.id; warning.append(id);
        warning.setAttribute('aria-label', `Duplicated ID ${instance.id}`);
        setInstanceTooltip(warning, duplicateTooltip(instance, instances));
        warning.addEventListener('click', () => this.options.onStatus?.(instance)); facts.append(warning);
      }
      body.append(facts);
      const date = document.createElement('div'); date.className = 'instance-date';
      if (instance.summary?.lastEdited) {
        const stamp = localDateStamp(instance.summary.lastEdited);
        const format = opts ?? { timeFormat: 'locale' as const };
        const time = document.createElement('time'); time.dateTime = instance.summary.lastEdited; time.textContent = formatDate(stamp, opts?.dateFormat);
        const zone = { instant: Date.parse(instance.summary.lastEdited) };
        const clock = document.createElement('span'); clock.textContent = formatClock(stamp, format, undefined, zone); date.append(time, clock);
        date.title = `Last edit: ${formatStamp(stamp, format, zone)}`;
      }
      const actions = document.createElement('div'); actions.className = 'instance-card-actions';
      const calendar = calendarTooltip(instance);
      if (calendar) {
        const status = document.createElement('button'); status.type = 'button'; status.className = 'instance-calendar-icon';
        status.innerHTML = CALENDAR_OFF_ICON; status.setAttribute('aria-label', calendar); setInstanceTooltip(status, calendar);
        status.addEventListener('click', () => this.options.onStatus?.(instance)); actions.append(status);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'instance-remove';
      remove.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      remove.setAttribute('aria-label', `Forget ${label} at ${instance.path}`);
      const children = !instance.worktree?.linked ? instances.filter(other => other.worktree?.linked && instanceGroup(other) === instanceGroup(instance)).length : 0;
      setInstanceTooltip(remove, children ? `Forget instance and ${children} registered worktree${children > 1 ? 's' : ''}. Files stay on your Mac.` : 'Forget instance. Forgetting an instance keeps its files on your Mac.');
      remove.addEventListener('click', () => {
        void this.mutate(async () => {
          const { instances } = await this.request<{ instances: AvailableInstance[] }>('instances/remove', { path: instance.path });
          return instances;
        }, 'Could not forget this instance. Try again.');
      });
      actions.append(remove); body.append(actions); row.append(date, body);
      return row;
    });
    this.list.replaceChildren(...rows);
    this.notice.textContent = instances.length ? '' : 'No instances yet. Add one to get started.';
    this.retry.hidden = true;
    if (restoreFocus && focus) this.focusElement(focus).focus();
  }
}
