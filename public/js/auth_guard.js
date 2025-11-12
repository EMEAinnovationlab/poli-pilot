// /js/auth_guard.js
export async function enforceRole({
  requiredRole = null,
  redirectIfUnauthorized = false,   // default: don't bounce while developing
  endpoint = '/api/me',             // use '/auth/me' if you really have that route
  timeoutMs = 5000
} = {}) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);

    const resp = await fetch(endpoint, {
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
    clearTimeout(to);

    if (!resp.ok) throw new Error(`auth ${resp.status}`);
    const data = await resp.json();
    const user = data?.user ?? null;
    const role = user?.role ?? null;

    if (requiredRole && role !== requiredRole) {
      if (redirectIfUnauthorized) {
        window.location.href = requiredRole === 'admin'
          ? '/admin_login.html' // underscore matches your file
          : '/login.html';
      }
      return { ok: false, user };
    }

    return { ok: true, user };
  } catch (err) {
    console.warn('Auth check failed; continuing:', err);
    if (redirectIfUnauthorized) {
      window.location.href = requiredRole === 'admin'
        ? '/admin_login.html'
        : '/login.html';
    }
    return { ok: false, user: null };
  }
}
