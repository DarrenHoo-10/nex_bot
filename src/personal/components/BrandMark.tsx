import mark from "../assets/nexbot-mark.svg?url";
export function BrandMark({ size = 32 }: { size?: number }) { return <img className="nex-brand-mark" src={mark} width={size} height={size} alt="NexBot" draggable={false}/>; }
