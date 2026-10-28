package com.nexorai.nexbot.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.nexorai.nexbot.core.ApprovalRow
import com.nexorai.nexbot.core.BotRow
import com.nexorai.nexbot.core.MessageRow
import com.nexorai.nexbot.data.ConnectionStore
import com.nexorai.nexbot.data.StoredConnection
import com.nexorai.nexbot.sync.Repository
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The chat screen compiles and lays out with a real approval card, a transcript
 * row and the composer. Device behaviour (IME, insets) is not covered here.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp")
class ChatScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private class MemoryStore : ConnectionStore {
        private var saved: StoredConnection? = null

        override fun load(): StoredConnection? = saved

        override fun save(connection: StoredConnection) {
            saved = connection
        }

        override fun clear() {
            saved = null
        }
    }

    private fun state() = Repository.UiState(
        phase = Repository.Phase.Ready,
        connection = StoredConnection(origin = "http://127.0.0.1:1"),
        bots = listOf(BotRow(id = "bot-1", name = "Ada")),
        selectedBotId = "bot-1",
        approvals = listOf(
            ApprovalRow(
                id = "approval-1",
                argumentHash = "hash-1",
                toolName = "device.exec",
                botId = "bot-1",
                argumentsJson = """{"command":"ls"}""",
            ),
        ),
        messages = listOf(
            MessageRow(id = "m1", botId = "bot-1", seq = 1, role = "assistant", kind = "message", content = "**hi** there"),
        ),
        connected = true,
    )

    @Test
    fun `shows the transcript, the approval buttons and the composer`() {
        val repository = Repository(store = MemoryStore())
        compose.setContent { NexTheme { ChatScreen(state(), repository) } }

        compose.onNodeWithText("批准").assertIsDisplayed()
        compose.onNodeWithText("拒绝").assertIsDisplayed()
        compose.onNodeWithContentDescription("发送").assertIsDisplayed()
        compose.onNodeWithText("给 Ada 发消息…").assertIsDisplayed()
        compose.onNodeWithText("等你批准").assertIsDisplayed()
        compose.onNodeWithText("标准权限").assertIsDisplayed()
        compose.onNodeWithContentDescription("添加").performClick()
        compose.onNodeWithText("文件").assertIsDisplayed()
        compose.onNodeWithText("新话题").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("导出对话").assertIsDisplayed()
    }

    @Test
    fun `new topic is unavailable on an empty conversation`() {
        val repository = Repository(store = MemoryStore())
        compose.setContent { NexTheme { ChatScreen(state().copy(messages = emptyList(), approvals = emptyList()), repository) } }

        compose.onNodeWithContentDescription("添加").performClick()
        compose.onNodeWithText("新话题").assertIsNotEnabled()
    }
}
