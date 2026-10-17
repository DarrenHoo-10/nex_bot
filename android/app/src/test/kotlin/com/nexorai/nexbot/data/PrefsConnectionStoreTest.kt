package com.nexorai.nexbot.data

import android.content.Context
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrefsConnectionStoreTest {
    /** Reversible stand-in for the Keystore; the real one is exercised on device. */
    private class FakeBox : SecretBox {
        override fun seal(plain: String): String = "sealed:" + plain.reversed()

        override fun open(sealed: String): String? =
            if (sealed.startsWith("sealed:")) sealed.removePrefix("sealed:").reversed() else null
    }

    private fun store(): PrefsConnectionStore =
        PrefsConnectionStore(RuntimeEnvironment.getApplication(), FakeBox())

    @Test
    fun `saves and reloads a connection through the seal`() {
        val connection = StoredConnection(
            origin = "https://bot.example.test",
            publicCoreId = "core-1",
            workspaceCoreId = "ws-1",
            name = "Pixel · Android",
            account = "owner@example.test",
            token = "token-1",
            sessionId = "session-1",
            expiresAt = 1_700_000_000_000,
        )
        val subject = store()
        subject.save(connection)
        assertEquals(connection, subject.load())
        subject.clear()
        assertNull(subject.load())
    }

    @Test
    fun `drops a record the box cannot open instead of failing forever`() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("nexbot", Context.MODE_PRIVATE).edit()
            .putString("connection", "not-sealed-at-all")
            .commit()
        val subject = PrefsConnectionStore(context, FakeBox())
        assertNull(subject.load())
        assertNull(context.getSharedPreferences("nexbot", Context.MODE_PRIVATE).getString("connection", null))
    }

    @Test
    fun `keeps the profile name and account across a save`() {
        val subject = store()
        subject.save(StoredConnection(origin = "http://192.168.1.4:8799", name = "Pixel", account = "a@b.test"))
        val loaded = subject.load()
        assertNotNull(loaded)
        assertEquals("Pixel", loaded.name)
        assertEquals("a@b.test", loaded.account)
    }
}
