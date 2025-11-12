// /public/js/auth_guard.js
// Small helper to ensure the user has a valid session cookie (pp_session).
// Usage (in any ES module):  import { enforceRole } from '/js/auth_guard.js';
// await enforceRole({ requiredRole: null });

export async function enforceRole({
  // null  = any logged-in user
  // 'admin' or 'member' = enforce that specific role
  requiredRole = null,
  redirectIfUnauthorized = false,
  // IMPORTANT: your API exposes /api/auth/me (not /api/me)
  endpoint = '/api/auth/me',
  timeoutMs = 5000
} = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);

  try {
    const r = await fetch(endpoint, {
      credentials: 'same-origin',
      signal: c.signal
    });
    clearTimeout(t);

    // When the function is misrouted, Vercel returns HTML (not JSON).
    // Try to parse JSON and gracefully handle HTML/error text.
    let data = null;
    try {
      data = await r.json();
    } catch {
      const text = await r.text().catch(() => '');
      const msg = text?.slice(0, 160) || 'Non-JSON response from auth endpoint';
      throw new Error(msg);
    }

    if (!r.ok || !data?.ok) {
      if (redirectIfUnauthorized) {
        window.location.href = '/login.html';
        return;
      }
      throw new Error('Unauthorized');
    }

    // If a specific role is required, check it
    if (requiredRole && data?.user?.role !== requiredRole) {
      if (redirectIfUnauthorized) {
        window.location.href = '/login.html';
        return;
      }
      throw new Error('Forbidden: role mismatch');
    }

    // All good
    return data?.user || null;
  } catch (err) {
    // Don’t hard-fail the page; let caller decide what to do.
    console.warn('Auth check failed; continuing:', err);
    if (redirectIfUnauthorized) {
      window.location.href = '/login.html';
    }
    // Re-throw in case caller wants to handle it
    throw err;
  }
}
