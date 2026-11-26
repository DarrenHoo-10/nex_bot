package com.nexorai.nexbot.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import java.io.IOException

class WorkspaceTransportTest {
    @Test fun `bridge rejects remote urls traversal and credential endpoints`() {
        for (path in listOf("https://elsewhere.test/api/state", "//elsewhere/api/state", "/api/../secret", "/api/%2e%2e/secret", "/api/a\\b", "/api/session", "/api/auth/respond", "/api/auth/refresh")) {
            assertFailsWith<IllegalArgumentException>(path) { WorkspaceTransport.validate(path, "POST") }
        }
        assertFailsWith<IllegalArgumentException> { WorkspaceTransport.validate("/api/state", "DELETE") }
        WorkspaceTransport.validate("/api/agents/messages?bot=a%2Fb", "GET")
    }
    @Test fun `only core image previews are served to the page`() {
        assertTrue(WorkspaceTransport.isAttachmentPreview("/api/attachments/0a1b-2c", "preview=1"))
        assertFalse(WorkspaceTransport.isAttachmentPreview("/api/attachments/0a1b-2c", null))
        assertFalse(WorkspaceTransport.isAttachmentPreview("/api/attachments/0a1b-2c/link", "preview=1"))
    }
    @Test fun `NexAgent images upload raw bytes and use a private preview route`() {
        val image = "/api/cli-agents/images/12345678-0000-4000-8000-000000000000"
        assertTrue(WorkspaceTransport.isCliImagePreview(image, null))
        assertTrue(WorkspaceTransport.isCliImagePreview(image, "preview=1"))
        assertFalse(WorkspaceTransport.isCliImagePreview(image, "ticket=temporary"))
        assertFalse(WorkspaceTransport.isCliImagePreview("$image/other", null))
        MockWebServer().use { server ->
            val client = WorkspaceTransport(server.url("/").toString(), { "fixture" })
            server.enqueue(MockResponse().setBody("{}"))
            val path = "/api/cli-agents/images?key=device%3Aclaude%3Asession"
            assertEquals(200, client.request(path, "POST", "iVBORw==").status)
            val request = server.takeRequest()
            assertEquals(path, request.path)
            assertEquals("Bearer fixture", request.getHeader("Authorization"))
            assertEquals("application/octet-stream", request.getHeader("Content-Type"))
            assertEquals("89504e47", request.body.readByteString().hex())
        }
    }
    @Test fun `a second viewer uses the private disk copy and logout blocks cache access`() {
        val directory = java.nio.file.Files.createTempDirectory("cli-history").toFile()
        try {
            MockWebServer().use { server ->
                var token: String? = "fixture"
                val origin = server.url("/").toString()
                val path = "/api/cli-agents/images/12345678-0000-4000-8000-000000000000"
                server.enqueue(MockResponse().setHeader("Content-Type", "image/webp").setBody("preview"))
                assertEquals("preview", WorkspaceTransport(origin, { token }).imagePreview(path, directory).body.decodeToString())
                val reopened = WorkspaceTransport(origin, { token })
                assertEquals("preview", reopened.imagePreview(path, directory).body.decodeToString())
                token = null
                assertFailsWith<IOException> { reopened.imagePreview(path, directory) }
                assertEquals(1, server.requestCount)
            }
        } finally { directory.deleteRecursively() }
    }
    @Test fun `requests use current native token and preserve server error statuses`() {
        MockWebServer().use { server ->
            var token: String? = "fixture-one"
            val client = WorkspaceTransport(server.url("/").toString(), { token })
            server.enqueue(MockResponse().setResponseCode(409).setBody("{\"error\":\"版本冲突\"}"))
            val reply = client.request("/api/config", "POST", "{\"contextWindow\":256000}")
            assertEquals(409, reply.status)
            val request = server.takeRequest()
            assertEquals("Bearer fixture-one", request.getHeader("Authorization"))
            assertEquals("{\"contextWindow\":256000}", request.body.readUtf8())
            token = "fixture-two"
            server.enqueue(MockResponse().setBody("{}"))
            client.request("/api/state", "GET", "")
            assertEquals("Bearer fixture-two", server.takeRequest().getHeader("Authorization"))
            token = null
            assertFailsWith<IOException> { client.request("/api/state", "GET", "") }
            assertEquals(2, server.requestCount)
        }
    }
    @Test fun `long-running cli-agents endpoints use the extended timeout`() {
        for (route in listOf("/api/cli-agents/start", "/api/cli-agents/continue", "/api/cli-agents/send", "/api/cli-agents/steer-waiting", "/api/cli-agents/translate", "/api/cli-agents/git", "/api/cli-agents/items", "/api/cli-agents/images")) {
            assertTrue(WorkspaceTransport.usesLongTimeout(route, null, "POST"), route)
        }
        assertFalse(WorkspaceTransport.usesLongTimeout("/api/state", null, "GET"))
    }
    @Test fun `redirect never forwards bearer to another origin`() {
        MockWebServer().use { server ->
            MockWebServer().use { destination ->
                server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", destination.url("/stolen")))
                val client = WorkspaceTransport(server.url("/").toString(), { "fixture" })
                assertEquals(302, client.request("/api/state", "GET", "").status)
                assertEquals(0, destination.requestCount)
            }
        }
    }
}
