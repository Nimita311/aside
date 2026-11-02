import type { FileDiagnostic } from '../../cli/src/core/data-snapshot';
import { showActionFailure } from './toast';

export function fileDiagnosticNotice(diagnostic: FileDiagnostic, retry: () => Promise<void>): HTMLElement {
  const notice = document.createElement('div'); notice.className = 'history-notice data-file-notice'; notice.dataset.path = diagnostic.path;
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = `${diagnostic.path}: ${diagnostic.error ? 'could not read' : 'partial or invalid data'}`;
  const list = document.createElement('ul');
  for (const issue of diagnostic.issues) {
    const item = document.createElement('li'); item.textContent = `${issue.field ? issue.field + ': ' : ''}${issue.message} (${issue.code})`; list.append(item);
  }
  if (diagnostic.error) { const item = document.createElement('li'); item.textContent = diagnostic.error; list.append(item); }
  const help = document.createElement('p'); help.textContent = 'Ask your agent to validate this instance and repair the reported file, then retry.';
  details.append(summary, list, help);
  const button = document.createElement('button'); button.type = 'button'; button.className = 'history-retry notice-action'; button.textContent = 'Retry';
  button.setAttribute('aria-label', `Retry ${diagnostic.path}`);
  button.addEventListener('click', async () => {
    button.disabled = true; button.textContent = 'Retrying…';
    try { await retry(); }
    catch (error) {
      if (button.isConnected && !notice.closest('[hidden], [inert]')) {
        details.querySelector('.retry-reason')?.remove();
        const reason = document.createElement('p'); reason.className = 'retry-reason';
        reason.textContent = error instanceof Error ? error.message : String(error);
        details.append(reason);
        showActionFailure('Could not retry this file. Try again.');
      }
    }
    finally { if (button.isConnected) { button.disabled = false; button.textContent = 'Retry'; } }
  });
  notice.append(details, button); return notice;
}
