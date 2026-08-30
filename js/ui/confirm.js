// A small promise-based confirmation dialog.
//
// Used where an action silently changes something the person can't see -- the
// confidence reorder moves rows that are usually off-screen, so it says what
// it's about to do before doing it.
//
// Deliberately not window.confirm: that can't say much, looks nothing like the
// rest of the board, and some mobile browsers suppress it.
import { escapeHtml } from './dom.js';

let openDialog = null;

/**
 * Returns a promise resolving true (confirmed) or false (cancelled).
 * Escape, the backdrop and Cancel all resolve false.
 */
export function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel' }){
  // Only ever one at a time.
  if(openDialog) openDialog.dismiss(false);

  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
        <div class="confirm-title" id="confirmTitle">${escapeHtml(title)}</div>
        <div class="confirm-body">${escapeHtml(body)}</div>
        <div class="confirm-actions">
          <button type="button" class="confirm-cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="confirm-ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;

    let settled = false;
    const dismiss = (result) => {
      if(settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      openDialog = null;
      resolve(result);
    };
    const onKey = (e) => {
      if(e.key === 'Escape'){ e.preventDefault(); dismiss(false); }
      if(e.key === 'Enter'){ e.preventDefault(); dismiss(true); }
    };

    overlay.querySelector('.confirm-ok').onclick = () => dismiss(true);
    overlay.querySelector('.confirm-cancel').onclick = () => dismiss(false);
    // Clicking the backdrop cancels; clicking inside the card must not.
    overlay.onclick = (e) => { if(e.target === overlay) dismiss(false); };
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    overlay.querySelector('.confirm-ok').focus();
    openDialog = { dismiss };
  });
}
