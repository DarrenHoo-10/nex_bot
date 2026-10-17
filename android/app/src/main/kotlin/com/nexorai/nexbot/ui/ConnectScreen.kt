package com.nexorai.nexbot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexorai.nexbot.sync.Repository

const val DefaultOrigin = "https://bot.nexorai.com.cn"

/**
 * The web login card from `doc/ui/login-light.png` exactly: mark, eyebrow,
 * title, two labelled fields and one blue button. The Core address is not a
 * field (the web gets it from the desktop shell); it lives behind the small
 * footer line so a self-hosted Core is still reachable.
 */
@Composable
fun ConnectScreen(state: Repository.UiState, onLogin: (String, String, String) -> Unit) {
    val extra = LocalNexExtra.current
    val uriHandler = LocalUriHandler.current
    var origin by rememberSaveable { mutableStateOf(state.connection?.origin?.takeIf { it.isNotBlank() } ?: DefaultOrigin) }
    var account by rememberSaveable { mutableStateOf(state.connection?.account ?: "") }
    var password by rememberSaveable { mutableStateOf("") }
    var serverOpen by rememberSaveable { mutableStateOf(false) }
    var serverDraft by rememberSaveable { mutableStateOf(origin) }
    val canSubmit = !state.busy && account.isNotBlank() && password.isNotEmpty()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(extra.loginBackground)
            .safeDrawingPadding()
            .imePadding(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp)
                .widthIn(max = 420.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Surface(
                shape = RoundedCornerShape(22.dp),
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                shadowElevation = 8.dp,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(32.dp)) {
                    NexMark(56.dp)
                    Spacer(Modifier.height(24.dp))
                    Text(
                        "登录 NexBot",
                        fontSize = 24.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onBackground,
                    )

                    if (state.phase == Repository.Phase.Starting) {
                        Spacer(Modifier.height(16.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp)
                            Spacer(Modifier.size(8.dp))
                            Text("正在检查登录状态…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    state.notice?.let { notice ->
                        Spacer(Modifier.height(12.dp))
                        Text(notice, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                    }

                    Spacer(Modifier.height(26.dp))
                    NexField(
                        value = account,
                        onValueChange = { account = it },
                        label = "邮箱",
                        placeholder = "输入你的邮箱",
                        enabled = !state.busy,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                    )
                    Spacer(Modifier.height(14.dp))
                    NexField(
                        value = password,
                        onValueChange = { password = it },
                        label = "密码",
                        placeholder = "输入密码",
                        enabled = !state.busy,
                        password = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { if (canSubmit) onLogin(origin, account, password) }),
                    )
                    state.error?.let { error ->
                        Spacer(Modifier.height(12.dp))
                        Text(error, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                    }
                    Spacer(Modifier.height(20.dp))
                    NexButton(
                        text = if (state.busy) "正在登录…" else "登录",
                        onClick = { onLogin(origin, account, password) },
                        enabled = canSubmit,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(16.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("没有账号？", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.size(5.dp))
                        Text(
                            "去注册",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier
                                .padding(vertical = 2.dp)
                                .clickable { runCatching { uriHandler.openUri("https://user.nexorai.com.cn/register/nexbot") } },
                        )
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
            Text(
                "服务器：${originLabel(origin)}",
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .semantics { contentDescription = "服务器设置" }
                    .clickable {
                        serverDraft = origin
                        serverOpen = true
                    }
                    .padding(vertical = 4.dp),
            )
        }
    }

    if (serverOpen) {
        AlertDialog(
            onDismissRequest = { serverOpen = false },
            title = { Text("服务器地址", fontSize = 16.sp) },
            text = {
                NexField(
                    value = serverDraft,
                    onValueChange = { serverDraft = it },
                    label = "地址",
                    placeholder = DefaultOrigin,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    origin = serverDraft.trim().trimEnd('/').ifEmpty { DefaultOrigin }
                    serverOpen = false
                }) { Text("保存") }
            },
            dismissButton = {
                TextButton(onClick = { serverOpen = false }) { Text("取消") }
            },
        )
    }
}

private fun originLabel(origin: String): String =
    origin.substringAfter("://").trimEnd('/').ifEmpty { origin }
