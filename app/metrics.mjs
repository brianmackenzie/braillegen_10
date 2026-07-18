// metrics.mjs — anonymous usage counting, if the visitor allows it.
//
// What is sent: a single fixed event name (like "generate-stl") to /api/event
// on this same origin — never the typed text, never an identifier stored in
// the browser. What is counted server-side: how many times each event fired
// and roughly how many distinct visitors appeared each day (via a salted
// hash; a fresh salt each day, salts and markers deleted within 48 hours;
// raw addresses are never stored).
//
// The beacon is skipped entirely when the browser sends Global Privacy
// Control, when the visitor turns counting off (the footer toggle stores the
// choice locally), or when the endpoint does not exist (self-hosted copies).
// Failures are silent by design — counting must never affect the app.
//
// AGPL-3.0 — part of the BrailleGen fork.

const OPT_OUT_KEY = 'bg-no-metrics';

export function metricsAllowed() {
  try {
    if (navigator.globalPrivacyControl === true) return false;
    if (localStorage.getItem(OPT_OUT_KEY) === '1') return false;
  } catch { /* storage blocked: treat as allowed but harmless either way */ }
  return true;
}

export function setMetricsOptOut(optOut) {
  try {
    if (optOut) localStorage.setItem(OPT_OUT_KEY, '1');
    else localStorage.removeItem(OPT_OUT_KEY);
  } catch {}
}

const EVENTS = new Set([
  'generate-stl', 'generate-svg', 'generate-brf', 'generate-txt',
  'generate-sign', 'generate-sign-inserts', 'generate-mini',
]);

/** Fire-and-forget count of one named event. Never throws, never blocks. */
export function recordEvent(name) {
  if (!EVENTS.has(name) || !metricsAllowed()) return;
  try {
    if (location.protocol === 'file:') return;
    // A keepalive GET (event name in the path, empty body) so the CDN can
    // sign the origin request; failures are silent by design.
    fetch('/api/event/' + name, { method: 'GET', keepalive: true, cache: 'no-store' })
      .catch(() => {});
  } catch { /* counting must never break the app */ }
}

/** Wire an optional footer/settings checkbox to the opt-out flag. */
export function bindMetricsToggle(checkbox) {
  if (!checkbox) return;
  if (navigator.globalPrivacyControl === true) {
    // GPC always wins; a checkable box would misrepresent behavior.
    checkbox.checked = false;
    checkbox.disabled = true;
    const note = document.createElement('span');
    note.textContent = " Your browser's Global Privacy Control is on, so counting stays off.";
    checkbox.closest('label')?.append(note);
    return;
  }
  checkbox.checked = metricsAllowed();
  checkbox.addEventListener('change', () => setMetricsOptOut(!checkbox.checked));
}
