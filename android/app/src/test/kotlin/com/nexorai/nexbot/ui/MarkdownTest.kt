package com.nexorai.nexbot.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MarkdownTest {
    private val link = Color(0xFF2F6F4E)
    private val code = Color(0xFFEDEAE2)

    @Test
    fun `inline emphasis, code and links become spans`() {
        val text = markdown(
            "hello **world** and `code` and *soft* [site](https://example.test/x)",
            link,
            code,
        )
        assertEquals("hello world and code and soft site", text.text)
        assertTrue(text.spanStyles.any { it.item.fontWeight == FontWeight.Bold })
        assertTrue(text.spanStyles.any { it.item.fontFamily == FontFamily.Monospace })
        assertTrue(text.spanStyles.any { it.item.fontStyle == FontStyle.Italic })
        val urls = text.getStringAnnotations("nexbot-url", 0, text.length)
        assertEquals(listOf("https://example.test/x"), urls.map { it.item })
    }

    @Test
    fun `fenced code stays literal and monospace`() {
        val text = markdown("run:\n```\nprintf '**not bold**'\n```\n", link, code)
        assertTrue(text.text.contains("printf '**not bold**'"))
        assertTrue(text.spanStyles.any { it.item.fontFamily == FontFamily.Monospace })
    }

    @Test
    fun `plain text is unchanged`() {
        val text = markdown("周一见。", link, code)
        assertEquals("周一见。", text.text)
        assertTrue(text.spanStyles.isEmpty())
    }

    @Test
    fun `list markers become bullets`() {
        val text = markdown("- 确认事项\n- 获取信息\n\n* 汇报结果", link, code)
        assertEquals("• 确认事项\n• 获取信息\n\n• 汇报结果", text.text)
    }
}
