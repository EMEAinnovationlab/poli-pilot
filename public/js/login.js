// /public/js/admin_login.js
// Load as: <script type="module" src="/js/admin_login.js"></script>

const form  = document.getElementById("admin-login-form"); // required in HTML
const email = document.getElementById("email");
const code  = document.getElementById("code");
const btn   = form?.querySelector('button[type="submit"]');

// Safety: ensure the form can't navigate away by itself
if (form) {
  form.setAttribute("action", "");
  form.setAttribute("method", "POST");
}

const msg = document.createElement("p");
msg.id = "login-message";
msg.style.fontSize = "14px";
msg.style.marginTop = "6px";
form?.appendChild(msg);

const setMsg = (text, isError = false) => {
  msg.textContent = text || "";
  msg.style.color = isError ? "#b10000" : "green";
};

const setBusy = (busy) => {
  if (!btn) return;
  btn.disabled = busy;
  btn.style.opacity = busy ? "0.6" : "1";
  btn.style.cursor  = busy ? "not-allowed" : "pointer";
};

const validEmail = (v = "") => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const validate = () => {
  const e = (email?.value || "").trim();
  const c = (code?.value  || "").trim();
  if (!validEmail(e)) { setMsg("Please enter a valid email address.", true); return false; }
  if (!c || c.length < 4) { setMsg("Please enter your admin code.", true); return false; }
  setMsg("");
  return true;
};

// If already logged in as admin, go straight to /admin.html
(async () => {
  if (!form) return;
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

// Handle submit
let submitting = false;
form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  e.stopPropagation();

  if (submitting) return;
  if (!validate()) return;

  submitting = true;
  setBusy(true);
  setMsg("Checking admin code…");

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);

  try {
    // Use the SAME endpoint as the user login (this one exists)
    const resp = await fetch("/auth/manual/verify", {
      method: "POST",
      credentials: "include", // allow Set-Cookie
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        email: email.value.trim(),
        code:  code.value.trim()
      }),
      signal: ctrl.signal
    });

    const raw = await resp.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { ok:false, error: raw || "Server error" }; }

    if (!resp.ok || !data?.ok) {
      setMsg(data?.error || "Invalid or expired admin code.", true);
      setBusy(false);
      submitting = false;
      return;
    }

    // Require admin role from the backend response
    const role = data?.user?.role ?? data?.role ?? null;
    if (role !== "admin") {
      setMsg("You are not authorized as admin.", true);
      setBusy(false);
      submitting = false;
      return;
    }

    setMsg("Login successful! Redirecting…");
    setTimeout(() => { window.location.href = "/admin.html"; }, 600);
  } catch {
    setMsg("Could not reach server. Please try again.", true);
    setBusy(false);
    submitting = false;
  } finally {
    clearTimeout(to);
  }
});

// Submit with Enter
[email, code].forEach((el) =>
  el?.addEventListener("keypress", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }
  })
);
