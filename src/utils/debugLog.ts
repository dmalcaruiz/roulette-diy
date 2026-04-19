// Small debug-logging helper used across the wheel/flow code paths.
// Produces consistent output like:
//
//   [BlockScreen] state-change block=diag-abc flowExp=exp-xyz steps=[a,b,c]
//
// Toggle off by setting VITE_DEBUG_FLOW=0 in .env.local.

const ENABLED =
  typeof window !== 'undefined' &&
  (import.meta.env.VITE_DEBUG_FLOW ?? '1') !== '0';

export function sid(id?: string | null): string {
  if (!id) return '∅';
  return id.slice(0, 8);
}

export function sids(ids?: Array<{ id: string } | string | null | undefined>): string {
  if (!ids) return 'ø';
  return '[' + ids.map(x => {
    if (!x) return '∅';
    if (typeof x === 'string') return sid(x);
    return sid(x.id);
  }).join(',') + ']';
}

export function dbg(scope: string, event: string, data?: Record<string, unknown>) {
  if (!ENABLED) return;
  const formatted = data
    ? Object.entries(data).map(([k, v]) => `${k}=${formatValue(v)}`).join(' ')
    : '';
  // eslint-disable-next-line no-console
  console.log(`[${scope}] ${event} ${formatted}`.trim());
}

function formatValue(v: unknown): string {
  if (v === null) return '∅';
  if (v === undefined) return 'undef';
  if (typeof v === 'string') return v.length <= 10 ? v : sid(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return sids(v as Array<{ id: string }>);
  if (typeof v === 'object' && 'id' in v) return sid((v as { id: string }).id);
  try { return JSON.stringify(v).slice(0, 60); } catch { return String(v); }
}
