// MAIN-world helper for content.js.
//
// content.js runs in Chrome's isolated world: it shares the DOM with the page
// but not its JavaScript heap, so React's fiber/props expandos on DOM nodes
// (__reactFiber$…, __reactProps$…) are invisible to it. This file runs in the
// page's own world (manifest "world": "MAIN") and answers one question on
// request: what is the pending approval card, according to React?
//
// The card root ([data-approval-card-root]) is rendered by a component whose
// props carry `pendingApproval.tool = { id, name, input, status }` — the raw
// tool call Claude is blocked on. That is the authoritative way to tell a
// tool-permission card from an AskUserQuestion card (confirmed on a live
// question card 2026-09-28: tool.name === "AskUserQuestion", input.questions
// = [{ header, question, multiSelect, options: [{ label, description }] }]).
//
// Protocol (synchronous — dispatchEvent runs listeners inline, so the
// isolated world gets its answer before dispatchEvent returns):
//   isolated → MAIN : CustomEvent 'claude-bridge:read-approval'
//   MAIN → isolated : CustomEvent 'claude-bridge:approval-meta', detail = JSON
//                     string (objects do not cross worlds; strings do).
// A JSON "null" means no card / no fiber / no pendingApproval found.
(() => {
  if (window.__claudeBridgePageHelper) return;
  window.__claudeBridgePageHelper = true;

  const MAX_STR = 4000;   // per-string cap on tool input we echo back
  const MAX_HOPS = 12;    // fiber ancestors to search above the card root

  // Serialise with a per-string cap so a permission card for a huge Write
  // does not turn get_state into a multi-megabyte response. Functions and
  // React internals are dropped.
  function trim(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string') return value.length > MAX_STR ? value.slice(0, MAX_STR) + `… [+${value.length - MAX_STR} chars]` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (depth > 8) return undefined;
    if (Array.isArray(value)) return value.map(v => trim(v, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k.startsWith('_') || k.startsWith('$$')) continue;
        const t = trim(v, depth + 1);
        if (t !== undefined) out[k] = t;
      }
      return out;
    }
    return undefined;
  }

  function readPendingApproval() {
    const root = document.querySelector('[data-approval-card-root]');
    if (!root) return null;
    const fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber'));
    if (!fiberKey) return null;
    let fiber = root[fiberKey];
    for (let hops = 0; fiber && hops < MAX_HOPS; hops++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      const pa = props && typeof props === 'object' ? props.pendingApproval : null;
      if (pa && typeof pa === 'object' && pa.tool) {
        return {
          tool: {
            id:     pa.tool.id ?? null,
            name:   pa.tool.name ?? null,
            status: pa.tool.status ?? null,
            input:  trim(pa.tool.input),
          },
          mustReachUser: pa.mustReachUser ?? null,
          defaultToNo:   pa.defaultToNo ?? null,
          queueDepth:    pa.queueDepth ?? null,
          hasAlwaysAllow: pa.hasAlwaysAllow ?? null,
        };
      }
    }
    return null;
  }

  window.addEventListener('claude-bridge:read-approval', () => {
    let payload = 'null';
    try { payload = JSON.stringify(readPendingApproval() ?? null); }
    catch (e) { payload = JSON.stringify({ error: String(e?.message ?? e) }); }
    window.dispatchEvent(new CustomEvent('claude-bridge:approval-meta', { detail: payload }));
  });
})();
