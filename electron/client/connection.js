const main = document.querySelector("main"), form = document.getElementById("connection"), button = document.getElementById("connect"), error = document.getElementById("error"), retry = document.getElementById("retry"), other = document.getElementById("other");
function setResuming(on) { main.classList.toggle("resuming", on); }
async function connect(value) {
  error.textContent = ""; button.disabled = retry.disabled = true; setResuming(!!value.resume);
  try { await window.nex.connect(value); } catch (e) { if (!e.message.includes("已取消")) error.textContent = e.message; setResuming(false); }
  finally { document.getElementById("password").value = ""; button.disabled = retry.disabled = false; }
}
form.addEventListener("submit", (event) => { event.preventDefault(); void connect({ origin: document.getElementById("origin").value, name: document.getElementById("name").value, email: document.getElementById("email").value, password: document.getElementById("password").value }); });
retry.addEventListener("click", () => void connect({ resume: true }));
other.addEventListener("click", () => { setResuming(false); void window.nex.cancelResume(); });
void window.nex.connection().then((info) => {
  document.getElementById("origin").value = info.origin || "https://bot.nexorai.com.cn"; document.getElementById("name").value = info.name ?? "我的电脑"; retry.hidden = !info.saved; error.textContent = info.error ?? "";
  setResuming(!!info.resuming);
}).finally(() => document.body.classList.add("ready"));
