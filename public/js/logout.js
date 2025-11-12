// /js/logout.js
document.addEventListener('DOMContentLoaded', () => {
  const btns = [document.getElementById('logout'), document.getElementById('logout-drawer')].filter(Boolean);

  const setBusy = (el, b) => {
    if (!el) return;
    el.dataset.originalText ??= el.textContent;
    el.textContent = b ? 'Logging out…' : el.dataset.originalText;
    el.style.opacity = b ? '0.6' : '1';
    el.style.pointerEvents = b ? 'none' : 'auto';
  };

  const doLogout = async (el) => {
    try {
      setBusy(el, true);
      const r = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      // even if response isn’t 200, try redirect (cookie likely cleared)
      window.location.href = '/login.html';
    } catch (e) {
      // fallback: force redirect; server will treat you as logged out anyway
      window.location.href = '/login.html';
    } finally {
      setBusy(el, false);
    }
  };

  btns.forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    doLogout(el);
  }));
});
