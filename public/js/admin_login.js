// /public/js/admin_login.js
document.addEventListener("DOMContentLoaded", () => {
  // Find the form by id OR by a generic class (works with your current HTML)
  const form =
    document.getElementById("login-form") ||
    document.querySelector("form.form");

  if (!form) return;

  const emailInput = document.getElementById("email");
  const codeInput  = document.getElementById("code");

  // Accept any of these submit button selectors
  const submitBtn = form.querySelector(
    'button[type="submit"], .form-submit, .login-submit'
  );

  const messageBox = document.createElement("p");
  messageBox.id = "login-message";
  messageBox.style.fontSize = "14px";
  messageBox.style.marginTop = "6px";
  form.appendChild(messageBox);

  const setMessage = (msg, isError = false) => {
    messageBox.textContent = msg || "";
    messageBox.style.color = isError ? "#b10000" : "green";
  };

  const setBusy = (busy) => {
    if (!submitBtn) return;
    submitBtn.disabled = busy;
    submitBtn.style.opacity = busy ? "0.6" : "1";
    submitBtn.style.cursor = busy ? "not-allowed" : "pointer";
  };

  const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const validateForm = () => {
    const email = emailInput?.value.trim();
    const code  = codeInput?.value.trim();
    if (!email || !validateEmail(email)) {
      setMessage("Please enter a valid email address.", true);
      return false;
    }
    if (!code || code.length < 4) {
      setMessage("Please enter your admin code.", true);
      return false;
    }
    setMessage("");
    return true;
  };

  form.addEventListener("input", () => {
    clearTimeout(form._t);
    form._t = setTimeout(validateForm, 300);
  });

  // Already logged in as admin? Go straight to /admin.html
  (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch("/auth/me", {
        method: "GET",
        credentials: "same-origin", // <-- critical: send cookies
        headers: { "Accept": "application/json" },
        signal: ctl.signal
      });
      const text = await r.text();
      let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
      if (r.ok && j?.ok && j.user?.role === "admin") {
        window.location.href = "/admin.html";
      }
    } catch {
      // ignore; they'll log in below
    } finally {
      clearTimeout(t);
    }
  })();

  // Prevent accidental double-submits
  let submitting = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!validateForm()) return;

    const email = emailInput.value.trim();
    const code  = codeInput.value.trim();

    setBusy(true);
    submitting = true;
    setMessage("Checking admin code…");

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);

    try {
      const resp = await fetch("/auth/admin/verify", {
        method: "POST",
        credentials: "same-origin",          // <-- critical: receive Set-Cookie
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ email, code }),
        signal: ctl.signal
      });

      // Be resilient to non-JSON errors
      const raw = await resp.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch {
        data = { ok: false, error: raw || "Unknown error" };
      }

      if (!resp.ok || !data?.ok) {
        setMessage(data?.error || "Invalid or expired admin code.", true);
        setBusy(false);
        submitting = false;
        return;
      }

      // Success: server should have set pp_session cookie (HttpOnly)
      setMessage("Login successful! Redirecting…");
      setTimeout(() => (window.location.href = "/admin.html"), 600);
    } catch (err) {
      setMessage("Could not reach server. Please try again.", true);
      setBusy(false);
      submitting = false;
    } finally {
      clearTimeout(t);
    }
  });

  // Submit on Enter in either field
  [emailInput, codeInput].forEach((input) =>
    input?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      }
    })
  );
});
