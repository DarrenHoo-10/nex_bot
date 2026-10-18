import Foundation

/// Chinese labels and phrases, copied from `src/personal/api.ts`.
public enum ToolLabels {
    static let statuses: [String: String] = [
        "queued": "排队中",
        "running": "执行中",
        "awaiting_approval": "等你批准",
        "paused": "已暂停",
        "needs_reconciliation": "需核对结果",
        "cancelling": "取消中",
        "succeeded": "已完成",
        "failed": "失败",
        "cancelled": "已取消",
        "rejected": "已拒绝",
        "bound": "已配对",
        "revoked": "已撤销",
        "pending": "待执行",
    ]
    static let labels: [String: String] = [
        "connector.list": "查看连接器",
        "connector.tools": "读取工具目录",
        "connector.call": "调用连接器工具",
        "agent.delegate": "联系同伴",
        "agent.directory": "查看同伴目录",
        "agent.create": "招募新同伴",
        "agent.update": "更新同伴资料",
        "memory.search": "检索记忆",
        "memory.read": "读取记忆",
        "memory.reflect": "综合记忆",
        "memory.write": "写入长期记忆",
        "memory.delete": "撤回记忆",
        "memory.forget": "清理记忆",
        "routine.list": "查看计划",
        "routine.save": "保存例行任务",
        "routine.toggle": "切换计划状态",
        "routine.run": "立即运行计划",
        "device.list": "查看设备目录",
        "device.read": "读取设备文件",
        "device.exec": "执行终端命令",
        "device.inventory": "检查设备目录",
        "device.info": "读取设备信息",
        "device.computer": "操作电脑窗口",
        "skill.list": "查看技能目录",
        "skill.read": "阅读技能说明",
    ]
    static let phrases: [String: String] = [
        "connector.list": "正在查看连接器",
        "connector.tools": "正在读取工具目录",
        "connector.call": "正在调用连接器工具",
        "agent.delegate": "正在联系同伴",
        "agent.directory": "正在查看同伴目录",
        "agent.create": "正在创建新同伴",
        "agent.update": "正在更新同伴资料",
        "memory.search": "正在检索记忆",
        "memory.read": "正在读取记忆",
        "memory.reflect": "正在综合记忆",
        "memory.write": "正在记录长期记忆",
        "memory.delete": "正在整理记忆",
        "memory.forget": "正在清理记忆",
        "routine.list": "正在查看计划",
        "routine.save": "正在安排例行任务",
        "routine.toggle": "正在调整计划",
        "routine.run": "正在执行例行任务",
        "device.list": "正在查看设备目录",
        "device.read": "正在读取设备文件",
        "device.exec": "正在执行终端命令",
        "device.inventory": "正在检查设备状态",
        "device.info": "正在读取设备信息",
        "device.computer": "正在操作电脑窗口",
        "skill.list": "正在查看技能目录",
        "skill.read": "正在阅读技能说明",
    ]
    static let approvalTitles: [String: String] = [
        "agent.delegate": "联系其他 Agent", "agent.create": "创建新的 Agent", "agent.update": "修改 Agent 的名字和身份说明",
        "memory.write": "写入长期记忆", "memory.forget": "彻底遗忘原文与相关副本（相关工作会停止）", "device.read": "读取设备文件",
        "device.list": "查看设备目录", "device.exec": "执行终端命令", "device.computer": "操作电脑窗口", "connector.call": "调用连接器工具",
    ]

    /// Collapsed tool-step label; unknown tools show their name.
    public static func label(for tool: String) -> String { labels[tool] ?? tool }
    /// Present-tense phrase while a tool runs.
    public static func phrase(for tool: String) -> String? { phrases[tool] }
    /// Task/call status text; unknown statuses return the raw value.
    public static func statusText(_ status: String) -> String { statuses[status] ?? status }
    /// Approval card title for a tool.
    public static func approvalTitle(_ tool: String) -> String { approvalTitles[tool] ?? tool }
    /// Port of `taskPhrase`: 正在停止… / 等你批准 / tool phrase / status / 执行中. Empty for no task.
    public static func taskPhrase(_ task: AgentTask?) -> String {
        guard let task else { return "" }
        switch task.status {
        case "cancelling": return "正在停止…"
        case "awaiting_approval": return "等你批准"
        default:
            if let tool = task.activeTool, !tool.isEmpty, let p = phrases[tool] { return p }
            return statuses[task.status] ?? "执行中"
        }
    }
}
