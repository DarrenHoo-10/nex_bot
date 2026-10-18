package com.nexorai.nexbot.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

@Composable
fun BackChevron(size: Dp = 22.dp, color: Color) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val path = Path().apply {
            moveTo(w * 0.62f, h * 0.18f)
            lineTo(w * 0.3f, h * 0.5f)
            lineTo(w * 0.62f, h * 0.82f)
        }
        drawPath(path, color, style = Stroke(width = w * 0.1f, cap = StrokeCap.Round))
    }
}

@Composable
fun PlusGlyph(size: Dp = 16.dp, color: Color) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val width = w * 0.09f
        drawLine(color, Offset(w / 2, 0f), Offset(w / 2, h), width, StrokeCap.Round)
        drawLine(color, Offset(0f, h / 2), Offset(w, h / 2), width, StrokeCap.Round)
    }
}

@Composable
fun UpArrow(size: Dp = 16.dp, color: Color) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val width = w * 0.11f
        drawLine(color, Offset(w / 2, h * 0.85f), Offset(w / 2, h * 0.15f), width, StrokeCap.Round)
        drawLine(color, Offset(w * 0.25f, h * 0.4f), Offset(w / 2, h * 0.15f), width, StrokeCap.Round)
        drawLine(color, Offset(w * 0.75f, h * 0.4f), Offset(w / 2, h * 0.15f), width, StrokeCap.Round)
    }
}

@Composable
fun SearchGlyph(size: Dp = 14.dp, color: Color) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val radius = w * 0.32f
        val width = w * 0.09f
        drawCircle(color, radius, Offset(radius + width, radius + width), style = Stroke(width))
        drawLine(color, Offset(radius * 2.2f + width, radius * 2.2f + width), Offset(w * 0.95f, h * 0.95f), width, StrokeCap.Round)
    }
}

@Composable
fun ChevronDown(size: Dp = 14.dp, color: Color) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val path = Path().apply {
            moveTo(w * 0.2f, h * 0.38f)
            lineTo(w * 0.5f, h * 0.68f)
            lineTo(w * 0.8f, h * 0.38f)
        }
        drawPath(path, color, style = Stroke(width = w * 0.1f, cap = StrokeCap.Round))
    }
}

@Composable
fun ChevronUpGlyph(size: Dp = 12.dp, color: Color) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val path = Path().apply {
            moveTo(w * 0.2f, h * 0.62f)
            lineTo(w * 0.5f, h * 0.32f)
            lineTo(w * 0.8f, h * 0.62f)
        }
        drawPath(path, color, style = Stroke(width = w * 0.1f, cap = StrokeCap.Round))
    }
}

@Composable
fun ShieldGlyph(size: Dp = 15.dp, color: Color, filled: Boolean = false) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val shield = Path().apply {
            moveTo(w * 0.5f, h * 0.08f)
            lineTo(w * 0.88f, h * 0.22f)
            lineTo(w * 0.88f, h * 0.5f)
            cubicTo(w * 0.88f, h * 0.72f, w * 0.7f, h * 0.88f, w * 0.5f, h * 0.94f)
            cubicTo(w * 0.3f, h * 0.88f, w * 0.12f, h * 0.72f, w * 0.12f, h * 0.5f)
            lineTo(w * 0.12f, h * 0.22f)
            close()
        }
        val check = Path().apply {
            moveTo(w * 0.32f, h * 0.5f)
            lineTo(w * 0.45f, h * 0.63f)
            lineTo(w * 0.7f, h * 0.36f)
        }
        if (filled) {
            drawPath(shield, color)
            drawPath(check, Color.White, style = Stroke(width = w * 0.09f, cap = StrokeCap.Round))
        } else {
            drawPath(shield, color, style = Stroke(width = w * 0.09f))
            drawPath(check, color, style = Stroke(width = w * 0.09f, cap = StrokeCap.Round))
        }
    }
}

@Composable
fun StopGlyph(size: Dp = 10.dp, color: Color) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        drawRoundRect(
            color,
            topLeft = Offset(w * 0.15f, h * 0.15f),
            size = Size(w * 0.7f, h * 0.7f),
            cornerRadius = CornerRadius(w * 0.12f),
        )
    }
}
