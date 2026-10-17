package com.nexorai.nexbot.ui

import com.nexorai.nexbot.core.BotRow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The avatar contract from `shared/personal-appearance.ts`: the first Agent is
 * soft/teal; every other Agent hashes into the 4x5 grid.
 */
class CompanionLookTest {
    private fun bot(id: String, name: String = "同伴") = BotRow(id = id, name = name)

    @Test
    fun `the first agent is the soft teal companion`() {
        val first = bot("agent-0", "工作助手")
        assertEquals(Appearance(CompanionShape.Soft, CompanionColor.Teal), CompanionLook.appearanceOf(first, first.id))
        assertEquals(Appearance(CompanionShape.Soft, CompanionColor.Teal), CompanionLook.appearanceOf(null, null))
    }

    @Test
    fun `later agents hash into shape and colour exactly as the web does`() {
        val first = bot("agent-0")
        assertEquals(
            Appearance(CompanionShape.Soft, CompanionColor.Plum),
            CompanionLook.appearanceOf(bot("agent-15"), first.id),
        )
        assertEquals(
            Appearance(CompanionShape.Pebble, CompanionColor.Ink),
            CompanionLook.appearanceOf(bot("agent-6"), first.id),
        )
        assertEquals(
            Appearance(CompanionShape.Bean, CompanionColor.Teal),
            CompanionLook.appearanceOf(bot("agent-1"), first.id),
        )
    }

    @Test
    fun `all twenty combinations are reachable`() {
        val pairs = (0..40).map { index ->
            CompanionLook.appearanceOf(bot("agent-$index"), "agent-0")
        }.toSet()
        assertEquals(20, pairs.size)
        assertEquals(5, pairs.map { it.color }.toSet().size)
        assertEquals(4, pairs.map { it.shape }.toSet().size)
    }

    @Test
    fun `labels follow the companion states`() {
        assertEquals("准备好了", companionLabel(CompanionState.Idle))
        assertEquals("正在思考", companionLabel(CompanionState.Thinking))
        assertEquals("正在执行", companionLabel(CompanionState.Working))
        assertEquals("等你批准", companionLabel(CompanionState.Approval))
        assertEquals("执行未完成", companionLabel(CompanionState.Failed))
        assertEquals("正在重新连接", companionLabel(CompanionState.Offline))
    }

    @Test
    fun `shape corner radii are the shared percentages`() {
        val shape = CompanionShape.Soft.corners
        assertEquals(listOf(27f, 35f, 27f, 35f), shape)
        assertTrue(CompanionShape.entries.all { it.corners.size == 4 })
    }
}
