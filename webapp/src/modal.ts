const stack: HTMLDialogElement[] = [];
const NATIVE_TRAVERSAL = 'audio[controls], video[controls], iframe, object, embed';
const FOCUSABLE = `button, a[href], input, select, textarea, summary, ${NATIVE_TRAVERSAL}, [contenteditable], [tabindex]`;
const focusGuards = new WeakSet<HTMLElement>();

export function activeModal(): HTMLDialogElement | undefined {
  return [...stack].reverse().find(dialog => dialog.open);
}

// Whether a node can take focus right now: connected, outside any hidden or
// inert subtree, not disabled, rendered, and not folded inside a closed
// details. Shared by every focus restoration in the app.
export function usable(node: HTMLElement | null): boolean {
  if (!node?.isConnected || node === document.body || node === document.documentElement || node.closest('[hidden], [inert]')) return false;
  if (node.matches(':disabled') || 'disabled' in node && node.disabled || node.getAttribute('aria-disabled') === 'true') return false;
  if (node instanceof HTMLInputElement && node.type === 'hidden') return false;
  const style = getComputedStyle(node);
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
    const ancestorStyle = getComputedStyle(ancestor);
    if (ancestorStyle.display === 'none' || ancestorStyle.contentVisibility === 'hidden') return false;
    if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
      const summary = Array.from(ancestor.children).find(child => child.tagName === 'SUMMARY');
      if (!summary?.contains(node)) return false;
    }
  }
  return true;
}

function tabIndex(node: HTMLElement): number {
  if (!node.hasAttribute('tabindex') && node.tagName === 'SUMMARY') {
    const details = node.parentElement;
    return details instanceof HTMLDetailsElement && Array.from(details.children).find(child => child.tagName === 'SUMMARY') === node ? 0 : -1;
  }
  return node.tabIndex;
}

function tabStops(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    .map(node => ({ node, index: tabIndex(node) }))
    .filter(({ node, index }) => !focusGuards.has(node) && usable(node) && index >= 0)
    .sort((a, b) => (a.index || Infinity) - (b.index || Infinity))
    .map(({ node }) => node);
}

function equivalent(node: HTMLElement | null): HTMLElement | null {
  if (usable(node)) return node;
  if (!node) return null;
  if (node.id) return document.getElementById(node.id);
  const href = node.getAttribute('href');
  return href ? Array.from(document.querySelectorAll<HTMLElement>('a[href]')).find(a => a.getAttribute('href') === href) ?? null : null;
}

export interface ModalController {
  open(): void;
  close(duration?: number): void;
  ensureFocus(): void;
}

// Native dialogs provide top-layer ordering and background inertness.
// Explicit Tab wrapping covers ordinary stops. Native media/embedded documents
// own their internal traversal; focus guards catch their actual boundaries.
export function createModal(dialog: HTMLDialogElement, options: {
  dismiss(): void;
  beforeOpen(): void;
  fallback(): HTMLElement | null;
  duration(): number;
}): ModalController {
  let launcher: HTMLElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let enteringNative = false;
  const guards = [document.createElement('span'), document.createElement('span')];
  for (const guard of guards) {
    guard.className = 'modal-focus-guard';
    guard.tabIndex = -1;
    guard.setAttribute('aria-hidden', 'true');
    guard.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
    focusGuards.add(guard);
  }
  function updateGuards(stops = tabStops(dialog)): void {
    if (dialog.firstChild !== guards[0]) dialog.prepend(guards[0]);
    if (dialog.lastChild !== guards[1]) dialog.append(guards[1]);
    // Match positive tabindex ordering as well as ordinary DOM order.
    guards[0].tabIndex = stops.length ? tabIndex(stops[0]) : 0;
    guards[1].tabIndex = stops.length ? tabIndex(stops.at(-1)!) : 0;
  }
  guards.forEach((guard, index) => guard.addEventListener('focus', () => {
    if (enteringNative || activeModal() !== dialog) return;
    const stops = tabStops(dialog);
    (index === 0 ? stops.at(-1) : stops[0])?.focus({ preventScroll: true });
    if (!stops.length) dialog.focus({ preventScroll: true });
  }));
  function restoreFocus(): void {
    const underneath = activeModal();
    let target = equivalent(launcher);
    if (underneath && (!target || !underneath.contains(target))) {
      target = tabStops(underneath)[0] ?? underneath;
    }
    if (!usable(target)) target = options.fallback();
    if (target && usable(target)) target.focus({ preventScroll: true });
  }
  function ensureFocus(): void {
    if (!dialog.open) {
      if (dialog.inert && !usable(document.activeElement as HTMLElement)) restoreFocus();
      return;
    }
    if (activeModal() !== dialog) return;
    updateGuards();
    if (dialog.contains(document.activeElement) && usable(document.activeElement as HTMLElement)) return;
    const target = tabStops(dialog)[0] ?? dialog;
    target.focus({ preventScroll: true });
  }
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (activeModal() === dialog) options.dismiss();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') event.stopPropagation();
    if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || activeModal() !== dialog) return;
    const focused = document.activeElement as HTMLElement | null;
    const stops = tabStops(dialog);
    updateGuards(stops);
    // Native controls expose their host as activeElement, even while an internal
    // button owns focus. Let the browser find the actual traversal boundary.
    if (focused?.matches(NATIVE_TRAVERSAL) && usable(focused)) return;
    const first = stops[0], last = stops.at(-1);
    if (!first || !focused || !stops.includes(focused) || focused === (event.shiftKey ? first : last)) {
      const destination = event.shiftKey ? last : first;
      if (destination?.matches(NATIVE_TRAVERSAL)) {
        // Focus just beyond the destination before native Tab runs. Backward
        // entry then reaches its final internal control, rather than its host.
        enteringNative = true;
        (event.shiftKey ? guards[1] : guards[0]).focus({ preventScroll: true });
        enteringNative = false;
        return;
      }
      event.preventDefault();
      destination?.focus({ preventScroll: true });
      if (!first) dialog.focus({ preventScroll: true });
    }
  });
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', event => { pressedOutside = event.target === dialog; });
  dialog.addEventListener('click', event => {
    if (pressedOutside && event.target === dialog && activeModal() === dialog) options.dismiss();
    pressedOutside = false;
  });
  return {
    open() {
      if (dialog.open) { ensureFocus(); return; }
      options.beforeOpen();
      launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      clearTimeout(hideTimer);
      const generation = ++revision;
      dialog.hidden = false;
      dialog.inert = false;
      dialog.removeAttribute('aria-hidden');
      stack.push(dialog);
      dialog.showModal();
      ensureFocus();
      requestAnimationFrame(() => {
        if (generation === revision && dialog.open) dialog.classList.add('is-visible');
      });
    },
    close(duration = options.duration()) {
      if (!dialog.open) return;
      revision++;
      clearTimeout(hideTimer);
      dialog.classList.remove('is-visible');
      // Closed dialogs can remain painted for their discrete exit transition,
      // but never retain keyboard targets or accessible content while closing.
      dialog.inert = true;
      dialog.setAttribute('aria-hidden', 'true');
      for (const guard of guards) guard.tabIndex = -1;
      dialog.close();
      const index = stack.lastIndexOf(dialog);
      if (index !== -1) stack.splice(index, 1);
      restoreFocus();
      const generation = revision;
      requestAnimationFrame(() => {
        if (generation === revision && !dialog.open && !usable(document.activeElement as HTMLElement)) restoreFocus();
      });
      hideTimer = setTimeout(() => { if (!dialog.open) dialog.hidden = true; }, duration);
      if (duration === 0) dialog.hidden = true;
    },
    ensureFocus,
  };
}
