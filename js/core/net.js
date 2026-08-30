// Network guards for reads that would otherwise hang forever.
//
// Firestore's get() has no timeout. On a flaky phone connection it can sit
// pending indefinitely -- not failing, just never settling -- which left pages
// showing "Loading…" with nothing to recover them. Switching tab and back was
// the only fix, because that started a fresh request.
//
// Everything that reads over the network goes through withTimeout so a stall
// becomes an error the UI can show and offer to retry.

export const NETWORK_TIMEOUT_MS = 12000;

export class TimeoutError extends Error {
  constructor(label){
    super(label ? `${label} timed out` : 'Request timed out');
    this.name = 'TimeoutError';
    this.isTimeout = true;
  }
}

/**
 * Rejects if `promise` hasn't settled within `ms`.
 *
 * The underlying request isn't cancelled -- Firestore gives us no handle to do
 * that -- but the caller stops waiting on it, which is what matters.
 */
export function withTimeout(promise, ms = NETWORK_TIMEOUT_MS, label = ''){
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs `fn` whenever the browser regains connectivity or the app is brought
 * back to the foreground, which is exactly when a stalled page should retry.
 * Returns an unsubscribe function.
 */
export function onBackOnline(fn){
  const wake = () => {
    if(document.visibilityState === 'hidden') return;
    if(navigator.onLine === false) return;
    fn();
  };
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', wake);
  return () => {
    window.removeEventListener('online', wake);
    document.removeEventListener('visibilitychange', wake);
  };
}
