package com.nexorai.nexbot.ui

import android.content.ActivityNotFoundException
import android.content.ContextWrapper
import android.content.Intent
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WorkspaceExternalTest {
    @Test fun `google consent opens outside webview and failed handoff can retry`() {
        var opened: Intent? = null
        var fail = true
        val context = object : ContextWrapper(RuntimeEnvironment.getApplication()) {
            override fun startActivity(intent: Intent) {
                if (fail) throw ActivityNotFoundException()
                opened = intent
            }
        }
        val url = "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic"
        assertEquals("无法打开浏览器，请重试", assertFailsWith<IllegalStateException> { openWorkspaceExternal(context, url) }.message)
        assertNull(opened)
        fail = false
        openWorkspaceExternal(context, url)
        assertEquals(Intent.ACTION_VIEW, opened?.action)
        assertEquals(url, opened?.dataString)
        for (invalid in listOf("javascript:alert(1)", "file:///tmp/private", "https://secret@example.test/", "intent://other")) {
            assertFailsWith<IllegalArgumentException> { openWorkspaceExternal(context, invalid) }
        }
    }
}
