package com.nexorai.nexbot.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.nexorai.nexbot.core.BotRow
import com.nexorai.nexbot.core.Copy
import com.nexorai.nexbot.sync.Repository
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The avatar contract from `shared/personal-appearance.ts`, which is what the
 * current workspace renders: four companion shapes and five colours, with the
 * first Agent as soft/teal and every other Agent hashed into the grid.
 */
enum class CompanionShape(val label: String, val corners: List<Float>) {
    Soft("软方", listOf(27f, 35f, 27f, 35f)),
    Bean("豆角", listOf(50f, 50f, 35f, 50f)),
    Pebble("卵石", listOf(52f, 40f, 48f, 28f)),
    Bud("新芽", listOf(52f, 12f, 52f, 12f)),
}

enum class CompanionColor(val label: String, val value: Color) {
    Teal("松青", Color(0xFF23756D)),
    Ink("墨色", Color(0xFF414853)),
    Blue("雾蓝", Color(0xFF426DAC)),
    Clay("陶红", Color(0xFFB26351)),
    Plum("烟紫", Color(0xFF7C608F)),
}

data class Appearance(val shape: CompanionShape, val color: CompanionColor) {
    fun cornerShape(size: Dp): CornerBasedShape {
        val (tl, tr, br, bl) = shape.corners
        return RoundedCornerShape(
            topStart = size * (tl / 100f),
            topEnd = size * (tr / 100f),
            bottomEnd = size * (br / 100f),
            bottomStart = size * (bl / 100f),
        )
    }
}

object CompanionLook {
    val shapes = CompanionShape.entries
    val colors = CompanionColor.entries

    fun appearanceOf(bot: BotRow?, firstId: String?): Appearance {
        if (bot == null || bot.id.isEmpty() || bot.id == firstId) {
            return Appearance(CompanionShape.Soft, CompanionColor.Teal)
        }
        var seed = 0u
        for (ch in bot.id) seed = seed * 31u + ch.code.toUInt()
        return Appearance(
            shapes[(seed % shapes.size.toUInt()).toInt()],
            colors[((seed / shapes.size.toUInt()) % colors.size.toUInt()).toInt()],
        )
    }
}

enum class CompanionState { Idle, Thinking, Working, Approval, Done, Failed, Paused, Offline }

fun companionState(state: Repository.UiState, bot: BotRow): CompanionState {
    if (!state.connected) return CompanionState.Offline
    if (state.approvals.any { it.botId == bot.id }) return CompanionState.Approval
    val task = state.tasks.firstOrNull { it.botId == bot.id }
    return when (task?.status) {
        "failed", "needs_reconciliation" -> CompanionState.Failed
        "paused", "cancelled", "rejected" -> CompanionState.Paused
        "succeeded" -> CompanionState.Done
        "queued" -> CompanionState.Thinking
        "running" -> if (task?.activeTool != null) CompanionState.Working else CompanionState.Thinking
        null -> CompanionState.Idle
        else -> CompanionState.Working
    }
}

fun companionLabel(state: CompanionState): String = when (state) {
    CompanionState.Idle -> "准备好了"
    CompanionState.Thinking -> "正在思考"
    CompanionState.Working -> "正在执行"
    CompanionState.Approval -> "等你批准"
    CompanionState.Done -> "已完成"
    CompanionState.Failed -> "执行未完成"
    CompanionState.Paused -> "已暂停"
    CompanionState.Offline -> "正在重新连接"
}

fun companionBadge(state: CompanionState, extra: NexExtraColors): Color? = when (state) {
    CompanionState.Approval -> extra.statusApproval
    CompanionState.Failed -> extra.statusFailed
    CompanionState.Offline, CompanionState.Paused -> extra.statusOffline
    CompanionState.Thinking, CompanionState.Working -> Color(0xFF398B76)
    CompanionState.Idle, CompanionState.Done -> null
}

/**
 * The brand mark from `src/personal/assets/nexbot-mark.svg`: a blue companion
 * with two attentive eyes and an upward swept corner.
 */
@Composable
fun NexMark(size: Dp, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val scale = this.size.minDimension / 512f
        val body = Path().apply {
            moveTo(64f * scale, 267f * scale)
            cubicTo(64f * scale, 153f * scale, 138f * scale, 78f * scale, 249f * scale, 78f * scale)
            cubicTo(291f * scale, 78f * scale, 330f * scale, 91f * scale, 360f * scale, 111f * scale)
            cubicTo(382f * scale, 104f * scale, 402f * scale, 85f * scale, 419f * scale, 64f * scale)
            cubicTo(430f * scale, 100f * scale, 427f * scale, 138f * scale, 413f * scale, 166f * scale)
            cubicTo(438f * scale, 194f * scale, 450f * scale, 230f * scale, 448f * scale, 271f * scale)
            cubicTo(444f * scale, 378f * scale, 367f * scale, 440f * scale, 257f * scale, 440f * scale)
            cubicTo(143f * scale, 440f * scale, 64f * scale, 382f * scale, 64f * scale, 267f * scale)
            close()
        }
        drawPath(
            path = body,
            brush = Brush.linearGradient(
                colors = listOf(Color(0xFF5285FF), Color(0xFF2859DC)),
                start = Offset(150f * scale, 85f * scale),
                end = Offset(346f * scale, 435f * scale),
            ),
        )
        val eye = Color(0xFFF2F6FF)
        drawRoundRect(eye, Offset(174f * scale, 212f * scale), Size(43f * scale, 82f * scale), CornerRadius(21.5f * scale))
        drawRoundRect(eye, Offset(285f * scale, 212f * scale), Size(43f * scale, 82f * scale), CornerRadius(21.5f * scale))
    }
}

@Composable
fun CompanionAvatar(
    bot: BotRow?,
    allBots: List<BotRow>,
    size: Dp,
    state: CompanionState = CompanionState.Idle,
    modifier: Modifier = Modifier,
) {
    val appearance = CompanionLook.appearanceOf(bot, allBots.firstOrNull()?.id)
    val extra = LocalNexExtra.current
    val badgePx = with(androidx.compose.ui.platform.LocalDensity.current) { size.toPx() }
    Box(
        modifier = modifier
            .size(size)
            .rotate(if (state == CompanionState.Approval) -6f else 0f),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(size * 0.06f)
                .clip(appearance.cornerShape(size)),
        ) {
            Canvas(Modifier.fillMaxSize()) {
                val w = this.size.width
                val h = this.size.height
                drawRect(appearance.color.value)
                drawRect(Brush.verticalGradient(listOf(Color.White.copy(alpha = 0.10f), Color.Transparent), startY = 0f, endY = h * 0.55f))
                drawRect(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.10f)), startY = h * 0.55f, endY = h))
                val eyeColor = Color(0xFFFFFDF6)
                if (state == CompanionState.Offline || state == CompanionState.Paused) {
                    drawRoundRect(eyeColor, Offset(w * 0.27f, h * 0.47f), Size(w * 0.17f, h * 0.09f), CornerRadius(w * 0.05f))
                    drawRoundRect(eyeColor, Offset(w * 0.56f, h * 0.47f), Size(w * 0.17f, h * 0.09f), CornerRadius(w * 0.05f))
                } else if (state == CompanionState.Done) {
                    drawArc(
                        color = eyeColor,
                        startAngle = 200f,
                        sweepAngle = 140f,
                        useCenter = false,
                        topLeft = Offset(w * 0.27f, h * 0.38f),
                        size = Size(w * 0.17f, h * 0.18f),
                        style = Stroke(width = w * 0.045f),
                    )
                    drawArc(
                        color = eyeColor,
                        startAngle = 200f,
                        sweepAngle = 140f,
                        useCenter = false,
                        topLeft = Offset(w * 0.56f, h * 0.38f),
                        size = Size(w * 0.17f, h * 0.18f),
                        style = Stroke(width = w * 0.045f),
                    )
                } else {
                    drawRoundRect(eyeColor, Offset(w * 0.27f, h * 0.29f), Size(w * 0.17f, h * 0.37f), CornerRadius(w * 0.085f))
                    drawRoundRect(eyeColor, Offset(w * 0.56f, h * 0.29f), Size(w * 0.17f, h * 0.37f), CornerRadius(w * 0.085f))
                    drawArc(
                        color = Color(0x38000000),
                        startAngle = 20f,
                        sweepAngle = 140f,
                        useCenter = false,
                        topLeft = Offset(w * 0.38f, h * 0.70f),
                        size = Size(w * 0.24f, h * 0.10f),
                        style = Stroke(width = w * 0.035f),
                    )
                }
            }
        }
        companionBadge(state, extra)?.let { color ->
            Canvas(Modifier.fillMaxSize()) {
                drawCircle(color, radius = badgePx * 0.11f, center = Offset(badgePx * 0.88f, badgePx * 0.88f))
                drawCircle(
                    color = extra.sidebar,
                    radius = badgePx * 0.15f,
                    center = Offset(badgePx * 0.88f, badgePx * 0.88f),
                    style = Stroke(width = badgePx * 0.045f),
                )
            }
        }
    }
}

fun timeLabel(epochMs: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    DateTimeFormatter.ofPattern("HH:mm").withZone(zone).format(Instant.ofEpochMilli(epochMs))

fun dayLabel(epochMs: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
    val day = Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate()
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    return when {
        day == today -> "今天"
        day == today.minusDays(1) -> "昨天"
        day.year == today.year -> DateTimeFormatter.ofPattern("M月d日").format(day)
        else -> DateTimeFormatter.ofPattern("yyyy年M月d日").format(day)
    }
}
