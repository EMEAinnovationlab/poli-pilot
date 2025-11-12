// /js/auth_guard.js
export async function enforceRole({ requiredRole = null, redirectIfUnauthorized = true } = {}) {
  try {
    const resp = await fetch('/auth/me', { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('unauthorized');
    const data = await resp.json();

    if (!data?.ok || !data.user) throw new Error('unauthorized');

    const { role } = data.user;

    // if a role is required and doesn't match
    if (requiredRole && role !== requiredRole) {
      if (redirectIfUnauthorized) {
        window.location.href =
          requiredRole === 'admin' ? '/admin-login.html' : '/login.html';
      }
      return false;
    }

    // ✅ Authorized
    return true;
  } catch (err) {
    if (redirectIfUnauthorized) {
      window.location.href =
        requiredRole === 'admin' ? '/admin_login.html' : '/login.html';
    }
    return false;
  }
}
