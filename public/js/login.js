// /js/login.js
document.addEventListener("DOMContentLoaded", () => {
  // Find the form by id OR by a generic class
  const form =
    document.getElementById("login-form") ||
    document.querySelector("form.form");
  if (!form) return;

  const emailInput = document.getElementById("email");
  const codeInput  = document.getElementById("code");

  // Support any submit button selector
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
    if (!code || code.length < 4)        { setMessage("Please enter your login code.", true); return false; }
    setMessage(""); return true;
  };

  form.addEventListener("input", () => {
    clearTimeout(form._t);
    form._t = setTimeout(validateForm, 300);
  });

  // Already logged in? redirect home
  (async () => {
    try {
      const r = await fetch("/auth/me", { credentials: "same-origin" });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j?.ok) window.location.href = "/";
      }
    } catch {}
  })();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateForm()) return;

    const email = emailInput.value.trim();
    const code  = codeInput.value.trim();

    setBusy(true);
    setMessage("Checking code…");

    try {
      const resp = await fetch("/auth/manual/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",          // <-- REQUIRED so Set-Cookie sticks
        redirect: "follow",
        body: JSON.stringify({ email, code }),
      });

      // Try to parse JSON; if it fails, show raw text
      let data = null;
      const text = await resp.text();
      try { data = text ? JSON.parse(text) : null; } catch {}

      if (!resp.ok || !data?.ok) {
        const msg =
          (data && (data.error || data.message)) ||
          (text && text.slice(0, 140)) ||
          "Invalid or expired code.";
        setMessage(msg, true);
        setBusy(false);
        return;
      }

      setMessage("Login successful! Redirecting…");
      // Give the browser a tick to persist the cookie before navigating
      setTimeout(() => (window.location.href = "/"), 400);
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
