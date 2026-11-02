/** Queue startup autofocus until the gallery makes this frame visible. */
export function deferPreviewFocus(): () => void {
  const focus = HTMLElement.prototype.focus;
  const showModal = HTMLDialogElement.prototype.showModal;
  let queued: { element: HTMLElement; options?: FocusOptions } | undefined;
  HTMLElement.prototype.focus = function (options?: FocusOptions) { queued = { element: this, options }; };
  HTMLDialogElement.prototype.showModal = function () {
    // Native showModal autofocus bypasses HTMLElement.focus. Opening the
    // dialog inert suppresses that focus without changing its open state.
    const inert = this.inert;
    this.inert = true;
    try { showModal.call(this); }
    finally { this.inert = inert; }
  };
  return () => {
    HTMLElement.prototype.focus = focus;
    HTMLDialogElement.prototype.showModal = showModal;
    const target = queued?.element;
    if (target?.isConnected && !target.closest('[hidden], [inert]') && getComputedStyle(target).display !== 'none') {
      focus.call(target, { ...queued?.options, preventScroll: true });
    }
    queued = undefined;
  };
}
