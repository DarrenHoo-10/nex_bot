const form = document.getElementById("connection"), button = document.getElementById("connect"), error = document.getElementById("error"), retry = document.getElementById("retry");
async function connect(value) {
  error.textContent = ""; button.disabled = retry.disabled = true;
  try { await window.nex.connect(value); } catch (e) { error.textContent = e.message; }
  finally { document.getElementById("password").value = ""; button.disabled = retry.disabled = false; }
}
form.addEventListener("submit", (event) => { event.preventDefault(); void connect({ origin: document.getElementById("origin").value, name: document.getElementById("name").value, email: document.getElementById("email").value, password: document.getElementById("password").value }); });
retry.addEventListener("click", () => void connect({ resume: true }));
void window.nex.connection().then((info) => { document.getElementById("origin").value = info.origin ?? ""; document.getElementById("name").value = info.name ?? "我的电脑"; retry.hidden = !info.saved; error.textContent = info.error ?? ""; });
