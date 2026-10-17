package com.nexorai.nexbot.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
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
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.io.FileOutputStream
import kotlin.test.assertTrue

/**
 * Smoke-renders the three P1 screens through Robolectric's native graphics.
 * It proves the screens draw real pixels (not an empty tree) and leaves PNGs
 * in `build/screens` for visual review; it does not compare against baselines.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenRenderTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

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

    private fun save(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(
            view.width.coerceAtLeast(1),
            view.height.coerceAtLeast(1),
            Bitmap.Config.ARGB_8888,
        )
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue(pixels.toSet().size > 8, "screen $name rendered blank")
        val dir = File("build/screens").apply { mkdirs() }
        FileOutputStream(File(dir, "$name.png")).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private val bots = listOf(
        BotRow(
            id = "agent-0",
            name = "工作助手",
            lastMessage = "可以。我们先把今天最重要的工作整理清楚，再逐项推进。",
            lastMessageAt = 1_791_656_000_000,
            unreadCount = 1,
        ),
        BotRow(
            id = "agent-15",
            name = "研究伙伴",
            lastMessage = "关注问题的依据，整理资料…",
            lastMessageAt = 1_791_650_000_000,
            unreadCount = 0,
        ),
    )

    private fun state() = Repository.UiState(
        phase = Repository.Phase.Ready,
        connection = StoredConnection(origin = "http://127.0.0.1:1", account = "owner@example.test"),
        bots = bots,
        selectedBotId = "agent-0",
        messages = listOf(
            MessageRow(
                id = "m1",
                botId = "agent-0",
                seq = 1,
                role = "user",
                kind = "message",
                content = "帮我整理今天的工作，稍后用连接器查询资料。",
                createdAt = 1_791_656_000_000,
            ),
            MessageRow(
                id = "m2",
                botId = "agent-0",
                seq = 2,
                role = "assistant",
                kind = "message",
                content = "可以。我们先把今天最重要的工作整理清楚，再逐项推进。\n\n- 确认要完成的事项\n- 用连接器获取所需信息\n- 完成后向你汇报结果",
                createdAt = 1_791_656_060_000,
            ),
        ),
        approvals = listOf(
            ApprovalRow(
                id = "a1",
                argumentHash = "hash",
                toolName = "device.exec",
                botId = "agent-0",
                argumentsJson = "{\n  \"command\": \"ls\"\n}",
            ),
        ),
        connected = true,
    )

    @Test
    fun `renders the chat`() {
        val repository = Repository(store = MemoryStore())
        compose.setContent { NexTheme(darkTheme = true) { ChatScreen(state(), repository) } }
        save("chat")
    }

    @Test
    fun `renders the agent list`() {
        compose.setContent { NexTheme { AgentsScreen(state(), onOpen = {}, onLogout = {}, onRefresh = {}) } }
        save("agents")
    }

    @Test
    fun `renders the login card`() {
        compose.setContent {
            NexTheme {
                ConnectScreen(
                    Repository.UiState(phase = Repository.Phase.Login),
                    onLogin = { _, _, _ -> },
                )
            }
        }
        save("connect")
    }
}
