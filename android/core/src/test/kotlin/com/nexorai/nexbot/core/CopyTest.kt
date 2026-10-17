package com.nexorai.nexbot.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CopyTest {
    @Test
    fun `task phrases prefer stopping, then approval, then the active tool`() {
        assertEquals("", Copy.taskPhrase(null))
        assertEquals("正在停止…", Copy.taskPhrase(TaskRow(status = "cancelling", activeTool = "device.exec")))
        assertEquals("等你批准", Copy.taskPhrase(TaskRow(status = "awaiting_approval", activeTool = "device.exec")))
        assertEquals("正在执行终端命令", Copy.taskPhrase(TaskRow(status = "running", activeTool = "device.exec")))
        assertEquals("执行中", Copy.taskPhrase(TaskRow(status = "running", activeTool = null)))
        assertEquals("需核对结果", Copy.taskPhrase(TaskRow(status = "needs_reconciliation")))
    }

    @Test
    fun `unknown identifiers fall back to themselves like the desktop`() {
        assertEquals("brand.new.tool", Copy.toolLabel("brand.new.tool"))
        assertEquals("某个新状态", Copy.statusLabel("某个新状态"))
        assertEquals("brand.new.tool", Copy.approvalLabel("brand.new.tool"))
        assertEquals("执行终端命令", Copy.approvalLabel("device.exec"))
        assertEquals("执行终端命令", Copy.toolLabel("device.exec"))
    }

    @Test
    fun `terminal statuses match the desktop list`() {
        for (status in listOf("succeeded", "failed", "cancelled", "rejected")) assertTrue(Copy.isTerminal(status), status)
        for (status in listOf("queued", "running", "awaiting_approval", "paused", "cancelling")) assertFalse(Copy.isTerminal(status), status)
    }

    @Test
    fun `sender labels cover user, system, peer and the bot`() {
        assertEquals("我", Copy.senderLabel(MessageRow(role = "user"), botName = "Ada", peerName = null))
        assertEquals("系统", Copy.senderLabel(MessageRow(role = "system"), botName = "Ada", peerName = null))
        assertEquals("Bob", Copy.senderLabel(MessageRow(role = "peer"), botName = "Ada", peerName = "Bob"))
        assertEquals("同伴 Agent", Copy.senderLabel(MessageRow(role = "peer"), botName = "Ada", peerName = null))
        assertEquals("Ada", Copy.senderLabel(MessageRow(role = "assistant"), botName = "Ada", peerName = null))
    }

    @Test
    fun `status map is the desktop vocabulary`() {
        assertEquals("等你批准", Copy.statusLabel("awaiting_approval"))
        assertEquals("需核对结果", Copy.statusLabel("needs_reconciliation"))
        assertEquals("正在安排例行任务", Copy.toolPhrases["routine.save"])
        assertEquals("联系其他 Agent", Copy.approvalLabels["agent.delegate"])
    }
}
