package com.nexorai.nexbot.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Tokens from `src/personal/vendor/rakazo/tokens.css` and the workspace
 * overrides in `src/personal/workspace.css` / `src/personal/identity.css`.
 * Keep these literals in step with the web UI: the phone and the desktop are
 * one product, and the design references live in `doc/ui/`.
 */
val LightColors = lightColorScheme(
    primary = Color(0xFF4D6BFE),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFE9EDFF),
    onPrimaryContainer = Color(0xFF1B2A6B),
    background = Color(0xFFFAFAF8),
    onBackground = Color(0xFF1A1A1A),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF1A1A1A),
    surfaceVariant = Color(0xFFF0F0ED),
    onSurfaceVariant = Color(0xFF6C6C70),
    outline = Color(0xFFEAEAE6),
    outlineVariant = Color(0xFFF0F0ED),
    error = Color(0xFFDC2626),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF7F1D1D),
)

val DarkColors = darkColorScheme(
    primary = Color(0xFF4D6BFE),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFF1B2350),
    onPrimaryContainer = Color(0xFFDCE3FF),
    background = Color(0xFF0B0C0E),
    onBackground = Color(0xFFECECEE),
    surface = Color(0xFF141518),
    onSurface = Color(0xFFECECEE),
    surfaceVariant = Color(0xFF18191E),
    onSurfaceVariant = Color(0xFF85858A),
    outline = Color(0xFF1E2026),
    outlineVariant = Color(0xFF1E2026),
    error = Color(0xFFEF4444),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFF3B1517),
    onErrorContainer = Color(0xFFFCA5A5),
)

/** Tokens Material 3 has no slot for; named as the web CSS names them. */
@Immutable
data class NexExtraColors(
    val sidebar: Color,
    val chatUserBubble: Color,
    /** `--primary`: near-black in light, near-white in dark, for strong buttons. */
    val strong: Color,
    val onStrong: Color,
    val warning: Color,
    val success: Color,
    val loginBackground: Color,
    val statusWorking: Color,
    val statusApproval: Color,
    val statusFailed: Color,
    val statusOffline: Color,
)

val LightExtra = NexExtraColors(
    sidebar = Color(0xFFF4F4F2),
    chatUserBubble = Color(0xFFF0F0ED),
    strong = Color(0xFF1A1A1A),
    onStrong = Color(0xFFF1F1EF),
    warning = Color(0xFFB7791F),
    success = Color(0xFF228B3B),
    loginBackground = Color(0xFFF5F6F8),
    statusWorking = Color(0xFF2563EB),
    statusApproval = Color(0xFFD79A37),
    statusFailed = Color(0xFFC15F55),
    statusOffline = Color(0xFF93979C),
)

val DarkExtra = NexExtraColors(
    sidebar = Color(0xFF111215),
    chatUserBubble = Color(0xFF18191E),
    strong = Color(0xFFF1F1EF),
    onStrong = Color(0xFF0B0C0E),
    warning = Color(0xFFE9C46A),
    success = Color(0xFF4ECB71),
    loginBackground = Color(0xFF0B0C0E),
    statusWorking = Color(0xFF3B82F6),
    statusApproval = Color(0xFFD79A37),
    statusFailed = Color(0xFFC15F55),
    statusOffline = Color(0xFF93979C),
)

val LocalNexExtra = staticCompositionLocalOf { LightExtra }

private val NexTypography = Typography().let { base ->
    base.copy(
        bodyLarge = base.bodyLarge.copy(fontSize = 14.sp, lineHeight = 25.sp),
        bodyMedium = base.bodyMedium.copy(fontSize = 13.sp, lineHeight = 20.sp),
        titleMedium = base.titleMedium.copy(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
        labelSmall = base.labelSmall.copy(fontSize = 10.sp, lineHeight = 14.sp),
    )
}

@Composable
fun NexTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalNexExtra provides if (darkTheme) DarkExtra else LightExtra) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColors else LightColors,
            typography = NexTypography,
            content = content,
        )
    }
}

/** The web UI uses `font-weight: 650` for product names; Material has no 650. */
val BrandWeight = FontWeight(650)
