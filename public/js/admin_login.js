// /js/admin_login.js
document.addEventListener("DOMContentLoaded", () => {
  const form =
    document.getElementById("login-form") ||
    document.querySelector("form.form");

  if (!form) return;

  const emailInput = document.getElementById("email");
  const codeInput  = document.getElementById("code");

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
    if (!email || !validateEmail(email)) { setMessage("Please enter a valid email address.", true); return false; }
    if (!code || code.length < 4)        { setMessage("Please enter your admin code.", true); return false; }
    setMessage(""); return true;
  };

  form.addEventListener("input", () => {
    clearTimeout(form._t);
    form._t = setTimeout(validateForm, 300);
  });

  // If already logged in as admin, go straight to /admin.html
  (async () => {
    try {
      const r = await fetch("/auth/me", { credentials: "same-origin" });
      if (r.ok) {
        const j = await r.json();
        if (j?.ok && j.user?.role === 'admin') {
          window.location.href = "/admin.html";
        }
      }
    } catch {}
  })();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateForm()) return;

    const email = emailInput.value.trim();
    const code  = codeInput.value.trim();

    setBusy(true);
    setMessage("Checking admin code…");

    try {
      const resp = await fetch("/auth/admin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
        credentials: "same-origin",
      });

      let data; try { data = await resp.json(); }
      catch { data = { ok: false, error: await resp.text() }; }

      if (!resp.ok || !data?.ok) {
        setMessage(data?.error || "Invalid or expired admin code.", true);
        setBusy(false);
        return;
      }

      setMessage("Login successful! Redirecting…");
      setTimeout(() => (window.location.href = "/admin.html"), 600);
    } catch (err) {
      setMessage("Could not reach server. Please try again.", true);
      setBusy(false);
    }
  });

  [emailInput, codeInput].forEach((input) =>
    input?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      }
    })
  );
});
