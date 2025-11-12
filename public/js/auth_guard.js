// /js/auth_guard.js

/**
 * Fetch current session info from the backend.
 * Returns: { ok: boolean, user?: { email: string, role: 'member'|'admin' } }
 */
export async function getSession() {
  try {
    const resp = await fetch('/auth/me', { credentials: 'same-origin' });
    // If not OK, return a consistent shape
    if (!resp.ok) return { ok: false };
    // Try to parse JSON; if it fails, treat as not authenticated
    const data = await resp.json().catch(() => ({ ok: false }));
    return (data && typeof data === 'object') ? data : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Convenience: boolean "is someone logged in?"
 */
export async function isLoggedIn() {
  const s = await getSession();
  return !!(s.ok && s.user && s.user.email);
}

/**
 * Enforce an auth requirement on a page.
 *
 * @param {Object} opts
 * @param {'admin'|'member'|null} opts.requiredRole - null = any logged-in, 'member' = member or admin, 'admin' = admin only
 * @param {boolean} [opts.redirectIfUnauthorized=true] - whether to redirect if requirement fails
 * @param {string}  [opts.loginPath='/login.html'] - where to send general users who need to log in
 * @param {string}  [opts.adminLoginPath='/admin_login.html'] - where to send users for admin-only pages
 * @param {(reason: 'unauthenticated'|'forbidden', session: any) => void} [opts.onUnauthorized] - optional hook before redirect
 *
 * @returns {Promise<boolean>} true if allowed to continue, false otherwise
 */
export async function enforceRole({
  requiredRole = null,
  redirectIfUnauthorized = true,
  loginPath = '/login.html',
  adminLoginPath = '/admin_login.html',
  onUnauthorized
} = {}) {

  const session = await getSession();

  // Not logged in at all
  if (!session.ok || !session.user) {
    if (onUnauthorized) onUnauthorized('unauthenticated', session);
    if (redirectIfUnauthorized) {
      // Admin-only pages send users to the admin login page; others go to general login
      window.location.href = (requiredRole === 'admin') ? adminLoginPath : loginPath;
    }
    return false;
  }

  const role = session.user.role;

  // Evaluate role requirement
  const roleAllowed =
    requiredRole === null ? (role === 'member' || role === 'admin') :
    requiredRole === 'member' ? (role === 'member' || role === 'admin') :
    requiredRole === 'admin' ? (role === 'admin') :
    false;

  if (!roleAllowed) {
    if (onUnauthorized) onUnauthorized('forbidden', session);
    if (redirectIfUnauthorized) {
      // If page is admin-only but user isn't admin, send to admin login
      if (requiredRole === 'admin') {
        window.location.href = adminLoginPath;
      } else {
        window.location.href = loginPath;
      }
    }
    return false;
  }

  // All good
  return true;
}

/**
 * Utility: ensure user is logged in (member or admin).
 * Redirects to /login.html if not.
 */
export async function requireAuth() {
  return enforceRole({ requiredRole: null });
}

/**
 * Utility: ensure user is admin.
 * Redirects to /admin_login.html if not.
 */
export async function requireAdmin() {
  return enforceRole({ requiredRole: 'admin' });
}
