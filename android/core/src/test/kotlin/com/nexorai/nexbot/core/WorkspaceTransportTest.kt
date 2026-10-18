package com.nexorai.nexbot.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import java.io.IOException

class WorkspaceTransportTest {
    @Test fun `bridge rejects remote urls traversal and credential endpoints`() {
        for (path in listOf("https://elsewhere.test/api/state", "//elsewhere/api/state", "/api/../secret", "/api/%2e%2e/secret", "/api/a\\b", "/api/session", "/api/auth/respond", "/api/auth/refresh")) {
            assertFailsWith<IllegalArgumentException>(path) { WorkspaceTransport.validate(path, "POST") }
        }
        assertFailsWith<IllegalArgumentException> { WorkspaceTransport.validate("/api/state", "DELETE") }
        WorkspaceTransport.validate("/api/agents/messages?bot=a%2Fb", "GET")
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
