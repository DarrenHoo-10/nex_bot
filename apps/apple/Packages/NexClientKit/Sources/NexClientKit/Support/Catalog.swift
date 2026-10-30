import Foundation

/// zh-CN time formatting that matches the web UI (`M/D HH:mm`). Pure functions so tests can pin time zone and clock.
public enum TimeFormat {
    private static func parts(_ date: Date, _ tz: TimeZone) -> (m: Int, d: Int, h: Int, min: Int) {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let c = cal.dateComponents([.month, .day, .hour, .minute], from: date)
        return (c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0)
    }
    private static func hm(_ p: (m: Int, d: Int, h: Int, min: Int)) -> String { String(format: "%02d:%02d", p.h, p.min) }
    private static func isSameDay(_ a: Date, _ b: Date, _ tz: TimeZone) -> Bool {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        return cal.isDate(a, inSameDayAs: b)
    }

    /// "10/17 09:05".
    public static func formatTime(_ date: Date, timeZone: TimeZone = .current) -> String {
        let p = parts(date, timeZone); return "\(p.m)/\(p.d) \(hm(p))"
    }
    /// "09:05" for today, otherwise "10/17" (contact rows, memory cards).
    public static func formatShortTime(_ date: Date, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        let p = parts(date, timeZone)
        return isSameDay(date, now, timeZone) ? hm(p) : "\(p.m)/\(p.d)"
    }
    /// 今天 / 昨天 / "10月17日" (transcript day dividers).
    public static func dayLabel(_ date: Date, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        if isSameDay(date, now, timeZone) { return "今天" }
        var cal = Calendar(identifier: .gregorian); cal.timeZone = timeZone
        if let yesterday = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(date, inSameDayAs: yesterday) { return "昨天" }
        let p = parts(date, timeZone); return "\(p.m)月\(p.d)日"
    }
}

/// An action id and its permission-editor label.
public struct PolicyAction: Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String
}

/// Tool actions offered by the shared permission editor.
public enum PolicyCatalog {
    public static let universalActions: Set<String> = ["image.models", "image.generate", "html.render"]
    /// Order of the server's `actions` list (`policy.ts`).
    public static let serverOrder: [String] = [
        "memory.search", "memory.reflect", "memory.read", "memory.write", "memory.delete", "memory.forget",
        "agent.directory", "agent.delegate", "agent.create", "agent.update",
        "todo.list", "todo.save",
        "routine.list", "routine.save", "routine.toggle", "routine.run",
        "device.inventory", "device.info", "device.list", "device.read", "device.exec", "device.computer",
        "skill.list", "skill.read", "connector.list", "connector.tools", "connector.call",
        "attachment.read", "image.models", "image.generate", "html.render",
    ]
    /// Order of the web checkbox grid, with Chinese labels.
    public static let uiOrder: [PolicyAction] = [
        .init(id: "memory.search", label: "检索自身与共享记忆"),
        .init(id: "memory.reflect", label: "综合记忆并引用来源"),
        .init(id: "memory.read", label: "读取自身与共享记忆"),
        .init(id: "memory.write", label: "维护自身私有记忆"),
        .init(id: "memory.delete", label: "撤回自身私有记忆"),
        .init(id: "memory.forget", label: "彻底遗忘相关原文与副本"),
        .init(id: "todo.list", label: "查看待办"),
        .init(id: "todo.save", label: "保存待办"),
        .init(id: "routine.list", label: "查看自己的计划"),
        .init(id: "routine.save", label: "安排或修改自己的计划"),
        .init(id: "routine.toggle", label: "暂停或恢复自己的计划"),
        .init(id: "routine.run", label: "立即运行自己的计划"),
        .init(id: "agent.directory", label: "读取 Agent 公开目录"),
        .init(id: "agent.delegate", label: "联系同伴"),
        .init(id: "agent.create", label: "按指示招募新同伴"),
        .init(id: "agent.update", label: "按指示更新同伴资料"),
        .init(id: "device.list", label: "查看已授权设备目录"),
        .init(id: "device.read", label: "读取已授权设备文件"),
        .init(id: "device.exec", label: "执行设备终端命令"),
        .init(id: "device.inventory", label: "识别设备与在线状态"),
        .init(id: "device.info", label: "读取设备系统信息"),
        .init(id: "device.computer", label: "使用获准的电脑窗口"),
        .init(id: "connector.list", label: "查看已授权连接器"),
        .init(id: "connector.tools", label: "查看连接器工具"),
        .init(id: "connector.call", label: "调用连接器工具"),
        .init(id: "attachment.read", label: "读取对话附件"),
        .init(id: "image.models", label: "查看生图模型"),
        .init(id: "image.generate", label: "按需生成图片"),
        .init(id: "html.render", label: "展示交互内容"),
        .init(id: "skill.list", label: "查看通用技能目录"),
        .init(id: "skill.read", label: "阅读通用技能说明"),
    ]
    public static func label(for action: String) -> String { uiOrder.first { $0.id == action }?.label ?? action }
    /// Footer note of the editor.
    public static let footnote = "危险操作需批准；已记住的授权自动执行。"
    /// Retain grants introduced by a newer Core when editing an unrelated checkbox.
    public static func orderedTools(_ selected: Set<String>) -> [String] {
        serverOrder.filter(selected.contains) + selected.subtracting(serverOrder).sorted()
    }
    /// Button text of the 设置 tab row: `已授权 {n} 项 · 配置`.
    public static func summary(count: Int) -> String { "已授权 \(count) 项 · 配置" }
}

/// Memory fact source classes (`memory/recall`).
public enum MemoryLabels {
    public static func sourceClass(_ value: String) -> String {
        switch value {
        case "user_stated": "用户陈述"
        case "peer_reported": "同伴转述"
        case "agent_inferred": "Agent 推断"
        case "synthesized": "主题"
        default: value
        }
    }
    /// 共享 / 私有.
    public static func scope(_ scope: String) -> String { scope == "workspace" ? "共享" : "私有" }
    /// Recall status line: 检索完成 / 记忆正在同步 / 语义记忆暂不可用.
    public static func recallStatus(_ status: String) -> String {
        switch status { case "available": "检索完成"; case "pending": "记忆正在同步"; default: "语义记忆暂不可用" }
    }
    /// Reflect status line: 综合完成 / 没有足够的记忆证据.
    public static func reflectStatus(_ status: String) -> String { status == "available" ? "综合完成" : "没有足够的记忆证据" }
    /// Forget status line.
    public static func forgetStatus(_ status: String) -> String {
        status == "completed" ? "遗忘已完成" : "原文已清理，正在清理引擎派生记忆。完成前旧 bank 不可读取。"
    }
}

/// Avatar picker data (names and colors) matching `avatars/appearance.ts`.
public enum AvatarCatalog {
    public struct Named: Sendable, Hashable, Identifiable { public let id: String; public let name: String }
    public struct Color: Sendable, Hashable, Identifiable { public let id: String; public let name: String; public let hex: UInt32 }
    public static let shapes: [Named] = [.init(id: "soft", name: "软方"), .init(id: "bean", name: "豆荚"), .init(id: "pebble", name: "卵石"), .init(id: "bud", name: "新芽")]
    public static let colors: [Color] = [
        .init(id: "teal", name: "松青", hex: 0x23756d), .init(id: "ink", name: "墨色", hex: 0x414853), .init(id: "blue", name: "雾蓝", hex: 0x426dac),
        .init(id: "clay", name: "陶红", hex: 0xb26351), .init(id: "plum", name: "灰紫", hex: 0x7c608f),
    ]
    /// The 20 classic portraits in picker order.
    public static let portraits: [Named] = [
        .init(id: "fox", name: "赤狐"), .init(id: "owl", name: "知更"), .init(id: "cat", name: "芝麻"), .init(id: "bear", name: "麦芽"),
        .init(id: "rabbit", name: "棉朵"), .init(id: "dog", name: "吐司"), .init(id: "panda", name: "竹白"), .init(id: "koala", name: "尤加"),
        .init(id: "tiger", name: "橘山"), .init(id: "deer", name: "林间"), .init(id: "penguin", name: "南极"), .init(id: "seal", name: "海盐"),
        .init(id: "otter", name: "栗子"), .init(id: "octopus", name: "墨墨"), .init(id: "frog", name: "青禾"), .init(id: "robot", name: "小钛"),
        .init(id: "astronaut", name: "阿波罗"), .init(id: "star", name: "星芒"), .init(id: "cloud", name: "云团"), .init(id: "sprout", name: "芽芽"),
    ]
    public static func portraitName(_ id: String) -> String { portraits.first { $0.id == id }?.name ?? id }
    /// "{色名}{形名}", the accessibility label of a companion combination.
    public static func companionName(shape: String, color: String) -> String {
        (colors.first { $0.id == color }?.name ?? color) + (shapes.first { $0.id == shape }?.name ?? shape)
    }
    /// Preview state buttons: idle 待命, thinking 思考, working 执行, approval 待确认, done 完成, offline 断线.
    public static let previewStates: [Named] = [
        .init(id: "idle", name: "待命"), .init(id: "thinking", name: "思考"), .init(id: "working", name: "执行"),
        .init(id: "approval", name: "待确认"), .init(id: "done", name: "完成"), .init(id: "offline", name: "断线"),
    ]
}

/// Detects `code` spans that name a previewable file.
public enum FilePathMatcher {
    private static let regex = try! NSRegularExpression(
        pattern: #"^(?:[\w.-]+[\\/])*[\w.-]+\.(md|txt|json|csv|yaml|yml|ts|tsx|js|jsx|mjs|py|sql|log|html|css|sh|ps1|toml|xml)$"#,
        options: [.caseInsensitive])
    public static func isFilePath(_ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}

extension ToolLabels {
    /// Banner texts shared by both apps.
    public static let noModelBanner = "连接模型后，Agent 就能开始工作。"
    public static let offlineBanner = "Core 连接中断，正在重新同步…"
}
