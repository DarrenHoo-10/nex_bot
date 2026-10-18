package com.nexorai.nexbot.ui

import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle

/**
 * Inline Markdown only: bold, italic, code, links, and fenced blocks rendered
 * monospace. Block layout (headings, lists, tables) is P2; the transcript
 * keeps line breaks and reads correctly today.
 */
@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    val annotated = remember(text, linkColor, codeBackground) { markdown(text, linkColor, codeBackground) }
    val uriHandler = LocalUriHandler.current
    ClickableText(
        text = annotated,
        modifier = modifier,
        style = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
        onClick = { offset ->
            annotated.getStringAnnotations(TAG_URL, offset, offset).firstOrNull()?.let { annotation ->
                runCatching { uriHandler.openUri(annotation.item) }
            }
        },
    )
}

private const val TAG_URL = "nexbot-url"

private val inline = Regex("(\\*\\*[^*\\n]+\\*\\*|`[^`\\n]+`|\\*[^*\\n]+\\*|\\[[^]\\n]+]\\([^)\\s]+\\))")

/** The transcript shows list items as bullets, as the web renderer does. */
private val listMarker = Regex("(?m)^([ \\t]*)[-*][ \\t]+")

internal fun markdown(source: String, linkColor: Color, codeBackground: Color): AnnotatedString = buildAnnotatedString {
    val parts = source.split("```")
    parts.forEachIndexed { index, part ->
        if (index % 2 == 1) {
            withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) {
                append(part.trim('\n'))
                append('\n')
            }
            return@forEachIndexed
        }
        val prose = part.replace(listMarker, "$1• ")
        var last = 0
        for (match in inline.findAll(prose)) {
            append(prose.substring(last, match.range.first))
            val token = match.value
            when {
                token.startsWith("**") && token.endsWith("**") ->
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(token.substring(2, token.length - 2)) }

                token.startsWith("`") && token.endsWith("`") ->
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) {
                        append(token.substring(1, token.length - 1))
                    }

                token.startsWith("*") && token.endsWith("*") ->
                    withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(token.substring(1, token.length - 1)) }

                token.startsWith("[") -> {
                    val label = token.substringAfter('[').substringBefore(']')
                    val url = token.substringAfter('(').substringBefore(')')
                    pushStringAnnotation(TAG_URL, url)
                    withStyle(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)) { append(label) }
                    pop()
                }

                else -> append(token)
            }
            last = match.range.last + 1
        }
        append(prose.substring(last))
    }
}
