// /public/js/admin_login.js
const form  = document.getElementById("admin-login-form");
const email = document.getElementById("email");
const code  = document.getElementById("code");

const msg = document.createElement("p");
msg.id = "login-message";
msg.style.fontSize = "14px";
msg.style.marginTop = "6px";
form.appendChild(msg);

const setMsg = (t, err=false) => {
  msg.textContent = t || "";
  msg.style.color = err ? "#b10000" : "green";
};

const btn = form.querySelector('button[type="submit"]');
const setBusy = (b) => {
  btn.disabled = b;
  btn.style.opacity = b ? "0.6" : "1";
  btn.style.cursor  = b ? "not-allowed" : "pointer";
};

const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || "");
const validate = () => {
  const e = (email.value || "").trim();
  const c = (code.value  || "").trim();
  if (!validEmail(e)) { setMsg("Please enter a valid email address.", true); return false; }
  if (!c || c.length < 4) { setMsg("Please enter your admin code.", true); return false; }
  setMsg("");
  return true;
};

// If already logged in as admin, go straight to /admin.html
(async () => {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch("/auth/me", {
      method: "GET",
      credentials: "include",
      headers: { "Accept": "application/json" },
      signal: ctrl.signal
    });
    const raw = await r.text();
    let j = null; try { j = raw ? JSON.parse(raw) : null; } catch {}
    if (r.ok && j?.ok && j.user?.role === "admin") {
      window.location.href = "/admin.html";
    }
  } catch { /* ignore */ } finally { clearTimeout(to); }
})();

let submitting = false;

form.addEventListener("submit", async (e) => {
  e.preventDefault();                 // ← critical: stop native navigation
  if (submitting) return;
  if (!validate()) return;

  submitting = true;
  setBusy(true);
  setMsg("Checking admin code…");

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);

  try {
    const resp = await fetch("/auth/admin/verify", {
      method: "POST",
      credentials: "include",         // send/receive cookies
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        email: email.value.trim(),
        code:  code.value.trim()
      }),
      signal: ctrl.signal
    });

    const raw = await resp.text();
    let data = null; try { data = raw ? JSON.parse(raw) : null; } catch { data = { ok:false, error: raw || "Server error" }; }

    if (!resp.ok || !data?.ok) {
      setMsg(data?.error || "Invalid or expired admin code.", true);
      setBusy(false);
      submitting = false;
      return;
    }

    setMsg("Login successful! Redirecting…");
    setTimeout(() => { window.location.href = "/admin.html"; }, 600);
  } catch (err) {
    setMsg("Could not reach server. Please try again.", true);
    setBusy(false);
    submitting = false;
  } finally {
    clearTimeout(to);
  }
});

// Optional UX nicety: press Enter to submit from either field
[email, code].forEach((el) => el?.addEventListener("keypress", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  }
}));
