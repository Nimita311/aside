import { activeModal, usable, type ModalController } from './modal';

interface FlowVisibility {
  hidden: boolean;
  inert: boolean;
  ariaHidden: string | null;
  scrollTop: number;
}

function equivalent(node: HTMLElement | null): HTMLElement | null {
  if (usable(node)) return node;
  if (!node) return null;
  if (node.id) {
    const replacement = document.getElementById(node.id);
    if (usable(replacement)) return replacement;
  }
  const href = node.getAttribute('href');
  return href ? Array.from(document.querySelectorAll<HTMLElement>('a[href]'))
    .find(anchor => anchor.getAttribute('href') === href && usable(anchor)) ?? null : null;
}

// A document is a normal Reader page. It shares navigation with the flow and
// never enters the modal stack or makes the workspace controls inactive.
export function createReaderPage(host: HTMLElement, body: HTMLElement, options: {
  beforeOpen(): void;
  fallback(): HTMLElement | null;
  changed(): void;
}): ModalController {
  const flow = document.getElementById('flow-scroll');
  let opened = false;
  let launcher: HTMLElement | null = null;
  let previousFlow: FlowVisibility | null = null;

  function focusReader(): void {
    if (!opened || host.hidden || host.inert || activeModal()) return;
    const target = body.querySelector<HTMLElement>('h1, h2, h3, [data-reader-presentation="html"] > iframe') ?? body;
    if (!target.hasAttribute('tabindex') && target.tagName !== 'IFRAME') target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }

  function ensureFocus(): void {
    if (!opened || host.hidden || host.inert || activeModal()) return;
    const active = document.activeElement as HTMLElement | null;
    if (usable(active)) return;
    // Replacing a focused document node can leave focus on the body. Recover
    // inside the Reader, but do not pull focus back from workspace controls
    // the user selected while an asynchronous render was in progress.
    focusReader();
  }

  return {
    open() {
      options.beforeOpen();
      if (!opened) {
        launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        previousFlow = flow ? {
          hidden: flow.hidden, inert: flow.inert, ariaHidden: flow.getAttribute('aria-hidden'), scrollTop: flow.scrollTop,
        } : null;
      }
      opened = true;
      host.hidden = false;
      host.inert = false;
      host.removeAttribute('aria-hidden');
      host.classList.add('is-open');
      if (flow) {
        flow.hidden = true;
        flow.inert = true;
        flow.setAttribute('aria-hidden', 'true');
      }
      // Older isolated app fixtures use a dialog host. Its nonmodal show()
      // keeps those fixtures usable without reviving the document overlay.
      if (host instanceof HTMLDialogElement && !host.open) host.show();
      options.changed();
      focusReader();
    },
    close(_duration = 0) {
      if (!opened) return;
      const active = document.activeElement as HTMLElement | null;
      const restore = (!!active && host.contains(active)) || !usable(active);
      opened = false;
      host.classList.remove('is-open');
      if (host instanceof HTMLDialogElement && host.open) host.close();
      host.hidden = true;
      host.inert = true;
      host.setAttribute('aria-hidden', 'true');
      if (flow && previousFlow) {
        flow.hidden = previousFlow.hidden;
        flow.inert = previousFlow.inert;
        if (previousFlow.ariaHidden === null) flow.removeAttribute('aria-hidden');
        else flow.setAttribute('aria-hidden', previousFlow.ariaHidden);
      }
      options.changed();
      // Restoring the native frame can change the flow's width. Apply its
      // saved position after that layout is back; hidden scrollers may report
      // zero and a width change can clamp their previous scroll position.
      if (flow && previousFlow) flow.scrollTop = previousFlow.scrollTop;
      if ((restore || !usable(document.activeElement as HTMLElement | null)) && !activeModal()) {
        const target = equivalent(launcher) ?? options.fallback();
        if (usable(target)) target?.focus({ preventScroll: true });
      }
      launcher = null;
      previousFlow = null;
    },
    ensureFocus,
  };
}
