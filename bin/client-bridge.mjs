export function createLoginRedirect(policy, location = globalThis.location) {
  return () => {
    if (policy.mode === 'app') {
      if (!policy.loginPath) throw new Error('Use a tela de login do aplicativo. Para redirecionamento automático, configure authUi.loginPath em moon.config.json.');
      if (location.pathname !== policy.loginPath) location.assign(policy.loginPath);
      return;
    }
    location.reload();
  };
}

export function createFunctionInvoker(auth, request = globalThis.fetch) {
  return async (name, payload = {}) => {
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(name)) throw new Error("Nome de função não suportado.");
    const token = await auth?.getAccessToken?.();
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    const response = await request("/api/functions/" + encodeURIComponent(name), {
      method: "POST", headers,
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "Falha na função local.");
      error.status = response.status; error.response = { status: response.status, data };
      throw error;
    }
    return { data, status: response.status };
  };
}

export function createLLMInvoker(auth, request = globalThis.fetch) {
  return async (params) => {
    const token = await auth?.getAccessToken?.();
    const response = await request('/api/ai/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(params),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || 'Falha na IA local.');
      error.status = response.status;
      error.response = { status: response.status, data };
      throw error;
    }
    return data;
  };
}

export async function ensureSession(auth, doc = globalThis.document) {
  let initialError = "";
  try { if (await auth.isAuthenticated()) return; }
  catch { initialError = "Não foi possível verificar sua sessão. Tente entrar novamente."; }
  return new Promise(resolve => {
    const panel = doc.createElement("main");
    panel.style.cssText = "max-width:400px;margin:10vh auto;padding:28px;font-family:system-ui;background:white;color:#172033;border:1px solid #ddd;border-radius:16px";
    panel.innerHTML = `<h1>Entre no aplicativo</h1><p>Seus dados ficam vinculados à sua conta neste banco. O login do Base44 não é transferido automaticamente.</p><form><label>E-mail<input name="email" type="email" autocomplete="email" required style="display:block;width:95%;padding:10px;margin:8px 0 16px"></label><label>Senha<input name="password" type="password" autocomplete="current-password" required style="display:block;width:95%;padding:10px;margin:8px 0 16px"></label><button type="submit">Entrar</button> <button type="button" data-register>Criar conta</button></form><p role="status" aria-live="polite"></p>`;
    const form = panel.querySelector("form"), status = panel.querySelector('[role="status"]');
    status.textContent = initialError;
    doc.body.appendChild(panel);
    const buttons = [...panel.querySelectorAll("button")];
    const submit = async register => {
      if (!form.reportValidity()) return;
      buttons.forEach(button => { button.disabled = true; });
      status.textContent = register ? "Criando sua conta..." : "Entrando...";
      try {
        const email = form.elements.email.value.trim(), password = form.elements.password.value;
        if (register) await auth.register({ email, password });
        else await auth.loginViaEmailPassword(email, password);
        form.elements.password.value = "";
        if (await auth.isAuthenticated()) { panel.remove(); resolve(); return; }
        status.textContent = "Confira o e-mail de confirmação. Após confirmar, volte e clique em Entrar.";
      } catch (error) { status.textContent = error.message || "Não foi possível entrar. Confira seus dados e sua conexão."; }
      finally { buttons.forEach(button => { button.disabled = false; }); }
    };
    form.addEventListener("submit", event => { event.preventDefault(); void submit(false); });
    panel.querySelector("[data-register]").addEventListener("click", () => { void submit(true); });
  });
}
