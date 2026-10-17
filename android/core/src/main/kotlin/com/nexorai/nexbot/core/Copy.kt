package com.nexorai.nexbot.core

/**
 * The Chinese copy the desktop Personal UI already uses.
 *
 * Source of truth is `src/personal/api.ts` (statuses, toolLabels, toolPhrases)
 * and the approval labels in `src/personal/AgentDesktop.tsx`. This is a copy,
 * not a second product vocabulary: an unknown tool or status falls back to the
 * raw identifier exactly as the desktop does, so a new Core tool cannot break a
 * phone build. `CopyDriftTest` pins the values that exist today.
 */
object Copy {
    private const val SOURCE = "src/personal/api.ts:40-44, src/personal/AgentDesktop.tsx:266"

    val statuses: Map<String, String> = mapOf(
        "queued" to "排队中",
        "running" to "执行中",
        "awaiting_approval" to "等你批准",
        "paused" to "已暂停",
        "needs_reconciliation" to "需核对结果",
        "cancelling" to "取消中",
        "succeeded" to "已完成",
        "failed" to "失败",
        "cancelled" to "已取消",
        "rejected" to "已拒绝",
        "bound" to "已配对",
        "revoked" to "已撤销",
        "pending" to "待执行",
    )

    val toolLabels: Map<String, String> = mapOf(
        "connector.list" to "查看连接器",
        "connector.tools" to "读取工具目录",
        "connector.call" to "调用连接器工具",
        "agent.delegate" to "联系同伴",
        "agent.directory" to "查看同伴目录",
        "agent.create" to "招募新同伴",
        "agent.update" to "更新同伴资料",
        "memory.search" to "检索记忆",
        "memory.read" to "读取记忆",
        "memory.reflect" to "综合记忆",
        "memory.write" to "写入长期记忆",
        "memory.delete" to "撤回记忆",
        "memory.forget" to "清理记忆",
        "routine.list" to "查看计划",
        "routine.save" to "保存例行任务",
        "routine.toggle" to "切换计划状态",
        "routine.run" to "立即运行计划",
        "device.list" to "查看设备目录",
        "device.read" to "读取设备文件",
        "device.exec" to "执行终端命令",
        "device.inventory" to "检查设备目录",
        "device.info" to "读取设备信息",
        "device.computer" to "操作电脑窗口",
        "skill.list" to "查看技能目录",
        "skill.read" to "阅读技能说明",
    )

    val toolPhrases: Map<String, String> = mapOf(
        "connector.list" to "正在查看连接器",
        "connector.tools" to "正在读取工具目录",
        "connector.call" to "正在调用连接器工具",
        "agent.delegate" to "正在联系同伴",
        "agent.directory" to "正在查看同伴目录",
        "agent.create" to "正在创建新同伴",
        "agent.update" to "正在更新同伴资料",
        "memory.search" to "正在检索记忆",
        "memory.read" to "正在读取记忆",
        "memory.reflect" to "正在综合记忆",
        "memory.write" to "正在记录长期记忆",
        "memory.delete" to "正在整理记忆",
        "memory.forget" to "正在清理记忆",
        "routine.list" to "正在查看计划",
        "routine.save" to "正在安排例行任务",
        "routine.toggle" to "正在调整计划",
        "routine.run" to "正在执行例行任务",
        "device.list" to "正在查看设备目录",
        "device.read" to "正在读取设备文件",
        "device.exec" to "正在执行终端命令",
        "device.inventory" to "正在检查设备状态",
        "device.info" to "正在读取设备信息",
        "device.computer" to "正在操作电脑窗口",
        "skill.list" to "正在查看技能目录",
        "skill.read" to "正在阅读技能说明",
    )

    val approvalLabels: Map<String, String> = mapOf(
        "agent.delegate" to "联系其他 Agent",
        "agent.create" to "创建新的 Agent",
        "agent.update" to "修改 Agent 的名字和身份说明",
        "memory.write" to "写入长期记忆",
        "memory.forget" to "彻底遗忘原文与相关副本（相关工作会停止）",
        "device.read" to "读取设备文件",
        "device.list" to "查看设备目录",
        "device.exec" to "执行终端命令",
        "device.computer" to "操作电脑窗口",
        "connector.call" to "调用连接器工具",
    )

    /** A task state the conversation stops waiting on. Mirrors the desktop list. */
    val terminalStatuses: Set<String> = setOf("succeeded", "failed", "cancelled", "rejected")

    fun toolLabel(toolName: String): String = toolLabels[toolName] ?: toolName

    fun approvalLabel(toolName: String): String = approvalLabels[toolName] ?: toolLabel(toolName)

    fun statusLabel(status: String): String = statuses[status] ?: status

    fun isTerminal(status: String): Boolean = status in terminalStatuses

    /**
     * The one-line "what is it doing now" caption: cancelling wins, then a
     * pending approval, then the active tool's own phrase, then the state.
     */
    fun taskPhrase(task: TaskRow?): String {
        if (task == null) return ""
        return when (task.status) {
            "cancelling" -> "正在停止…"
            "awaiting_approval" -> "等你批准"
            else -> toolPhrases[task.activeTool.orEmpty()] ?: statuses[task.status] ?: "执行中"
        }
    }

    /** Who wrote a transcript row, using the same fallbacks as the desktop. */
    fun senderLabel(message: MessageRow, botName: String, peerName: String?): String = when (message.role) {
        "user" -> "我"
        "system" -> "系统"
        "peer" -> peerName ?: "同伴 Agent"
        else -> botName
    }

    /** The approval card's one-sentence explanation. */
    fun approvalDescription(toolName: String): String = approvalLabel(toolName)

    fun source(): String = SOURCE
}
