import mark from "../assets/nexbot-mark.svg?url";
import agentMark from "../assets/nexagent-mark.svg?url";
/** NexBot's blue mark; `agent` is the same mark in red for NexAgent. */
export function BrandMark({ size = 32, agent = false }: { size?: number; agent?: boolean }) { return <img className="nex-brand-mark" src={agent ? agentMark : mark} width={size} height={size} alt={agent ? "NexAgent" : "NexBot"} draggable={false}/>; }
