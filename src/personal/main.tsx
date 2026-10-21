import { createRoot } from "react-dom/client";
import { AgentDesktop } from "./AgentDesktop";
import { LoginGate } from "./auth";
import { api } from "./api";
import { ErrorBoundary } from "./ErrorBoundary";
import "./agent.css";
import "./workspace.css";
import "./identity.css";
import "./settings.css";
import "./home.css";
import "../../electron/client/style.css";
async function boot() {
 const token = new URLSearchParams(location.hash.slice(1)).get("token");
 if (token) { await api("session", { token }); history.replaceState(null, "", location.pathname); }
 createRoot(document.getElementById("root")!).render(<ErrorBoundary><LoginGate><AgentDesktop/></LoginGate></ErrorBoundary>);
}
void boot().catch(() => { document.getElementById("root")!.textContent = "NexBot 连接失败，请重启应用。"; });
