package com.nexorai.nexbot.ui

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.nexorai.nexbot.core.LiveFrame
import com.nexorai.nexbot.core.WorkspaceTransport
import com.nexorai.nexbot.sync.Repository
import com.nexorai.nexbot.update.AppUpdater
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.MessageDigest

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WorkspaceScreen(state: Repository.UiState, repository: Repository) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val connection = requireNotNull(state.connection)
    // Separate persistent web preferences for every account/server, with no credential in the URL.
    val namespace = remember(connection.origin, connection.account) {
        MessageDigest.getInstance("SHA-256").digest("${connection.origin}\n${connection.account}".toByteArray())
            .take(16).joinToString("") { "%02x".format(it) }
    }
    val workspace = remember(namespace) { AndroidWorkspace(context, repository, "https://$namespace.nexbot.invalid", connection.origin) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        workspace.fileCallback?.onReceiveValue(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
        workspace.fileCallback = null
    }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri -> workspace.finishSave(uri) }
    workspace.pickFiles = { picker.launch(arrayOf("*/*")) }
    workspace.chooseSave = { saver.launch(it) }
    BackHandler { workspace.web.evaluateJavascript("window.dispatchEvent(new Event('nex-android-back'))", null) }
    LaunchedEffect(state.selectedBotId) {
        state.selectedBotId?.let { workspace.selectBot(it) }
    }
    DisposableEffect(workspace, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> workspace.resume()
                Lifecycle.Event.ON_STOP -> workspace.pause()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); workspace.close() }
    }
    AndroidView(factory = { workspace.web }, modifier = Modifier.fillMaxSize().safeDrawingPadding())
}

/** Only bundled assets are loaded in this WebView. Remote pages open in the browser. */
@SuppressLint("SetJavaScriptEnabled")
internal class AndroidWorkspace(private val context: Context, private val repository: Repository, private val origin: String, coreOrigin: String) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val transport = repository.workspaceTransport()
    private val subscriptions = mutableSetOf<String>()
    private val streams = mutableMapOf<String, Job>()
    private var active = true
    private var closed = false
    private var pendingBot: String? = null
    private var loaded = false
    private data class Save(val id: String, val bytes: ByteArray)
    private var save: Save? = null
    var fileCallback: ValueCallback<Array<Uri>>? = null
    var pickFiles: () -> Unit = {}
    var chooseSave: (String) -> Unit = {}
    private val updater = AppUpdater(context, coreOrigin) { state ->
        if (!closed) web.evaluateJavascript("window.dispatchEvent(new CustomEvent('nex-android-update',{detail:$state}))", null)
    }

    val web = WebView(context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = true // Android's user-selected document handles.
        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.setSupportMultipleWindows(false)
        if ((context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true)
        addJavascriptInterface(this@AndroidWorkspace, "NexAndroid")
        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>, params: FileChooserParams?): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                try { pickFiles() } catch (_: Exception) {
                    fileCallback?.onReceiveValue(null); fileCallback = null
                    Toast.makeText(context, "无法打开文件选择器", Toast.LENGTH_SHORT).show()
                }
                return true
            }
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
                if (request.hasGesture()) runCatching { external(request.url.toString()) }
                    .onFailure { Toast.makeText(context, "无法打开链接", Toast.LENGTH_SHORT).show() }
                return true
            }
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                val path = uri.path.orEmpty()
                // Image previews come from Core with the native token; storage URLs never reach the page.
                if (request.method == "GET" && "https://${uri.host}" == origin && WorkspaceTransport.isAttachmentPreview(path, uri.query)) {
                    return try {
                        val reply = transport.request("$path?preview=1", "GET", "")
                        val mime = reply.contentType.substringBefore(';').trim()
                        if (reply.status == 200 && mime.startsWith("image/")) response(200, mime, ByteArrayInputStream(reply.body))
                        else response(404, "text/plain", ByteArrayInputStream(ByteArray(0)))
                    } catch (_: Exception) { response(404, "text/plain", ByteArrayInputStream(ByteArray(0))) }
                }
                if (uri.scheme != "https" || "https://${uri.host}" != origin || request.method != "GET" ||
                    path.contains("..") || path.contains('\\') || !(path == "/" || path == "/index.html" || path.startsWith("/assets/"))) {
                    return response(403, "text/plain", ByteArrayInputStream(ByteArray(0)))
                }
                return try {
                    val asset = if (path == "/") "index.html" else path.removePrefix("/")
                    val mime = when (asset.substringAfterLast('.')) {
                        "html" -> "text/html"; "js" -> "application/javascript"; "css" -> "text/css"
                        "svg" -> "image/svg+xml"; "png" -> "image/png"; "webp" -> "image/webp"; else -> "application/octet-stream"
                    }
                    response(200, mime, context.assets.open("workspace/$asset"))
                } catch (_: Exception) { response(404, "text/plain", ByteArrayInputStream(ByteArray(0))) }
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                loaded = true
                pendingBot?.let { selectBot(it) }
            }
        }
        loadUrl("$origin/index.html")
    }
    init { updater.start(scope) }

    private fun response(code: Int, mime: String, stream: java.io.InputStream) = WebResourceResponse(mime, "UTF-8", code, if (code == 200) "OK" else "Blocked", mapOf(
        "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff",
        "Content-Security-Policy" to "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    ), stream)

    private fun reply(id: String, result: JSONObject) {
        if (!closed) web.evaluateJavascript("window.__nexReply?.(${JSONObject.quote(id)},$result)", null)
    }
    private fun event(id: String, type: String, data: String = "") {
        if (!closed) web.evaluateJavascript("window.__nexEvent?.(${JSONObject.quote(id)},${JSONObject.quote(type)},${JSONObject.quote(data)})", null)
    }
    @JavascriptInterface fun request(id: String, path: String, method: String, body: String) {
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) { transport.request(path, method, body) }
                reply(id, JSONObject().put("status", result.status).put("body", result.body.toString(Charsets.UTF_8)))
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                reply(id, JSONObject().put("error", failure.message ?: "连接失败"))
            }
        }
    }
    @JavascriptInterface fun action(id: String, name: String, value: String) {
        scope.launch {
            try {
                when (name) {
                    "forget" -> repository.forgetWorkspace()
                    "copy" -> (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("NexBot", value))
                    "external" -> external(value)
                    "background" -> (context as? ComponentActivity)?.moveTaskToBack(true)
                    "ready" -> repository.state.value.selectedBotId?.let { selectBot(it) }
                    "updateState" -> { reply(id, JSONObject().put("value", updater.state)); return@launch }
                    "installUpdate" -> updater.install()
                    "save" -> {
                        check(save == null) { "请先完成当前保存" }
                        val data = JSONObject(value)
                        beginSave(id, data.getString("name"), data.getString("content").toByteArray()); return@launch
                    }
                    "download" -> {
                        check(save == null) { "请先完成当前保存" }
                        val data = JSONObject(value)
                        val url = data.getString("url")
                        require(url.startsWith("/api/attachments/")) { "附件地址无效" }
                        val result = withContext(Dispatchers.IO) { transport.request(url, "GET", "") }
                        check(result.status == 200) { "附件下载失败" }
                        beginSave(id, data.optString("name").ifBlank { "附件" }, result.body); return@launch
                    }
                    else -> error("不支持的操作")
                }
                reply(id, JSONObject().put("value", true))
            } catch (failure: Exception) { reply(id, JSONObject().put("error", failure.message ?: "操作失败")) }
        }
    }
    private fun beginSave(id: String, name: String, bytes: ByteArray) {
        save = Save(id, bytes)
        try { chooseSave(name.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(180)) }
        catch (failure: Exception) { save = null; throw IllegalStateException("无法打开文件保存窗口", failure) }
    }
    fun finishSave(uri: Uri?) {
        val current = save ?: return
        save = null
        scope.launch {
            try {
                if (uri != null) withContext(Dispatchers.IO) {
                    checkNotNull(context.contentResolver.openOutputStream(uri, "wt")).use { it.write(current.bytes) }
                }
                reply(current.id, JSONObject().put("value", uri != null))
            } catch (_: Exception) { reply(current.id, JSONObject().put("error", "文件保存失败")) }
        }
    }
    private fun external(url: String) {
        openWorkspaceExternal(context, url)
    }
    @JavascriptInterface fun subscribe(id: String) { scope.launch { subscriptions.add(id); startStream(id) } }
    @JavascriptInterface fun unsubscribe(id: String) { scope.launch { subscriptions.remove(id); streams.remove(id)?.cancel() } }
    private fun startStream(id: String) {
        if (!active || streams[id]?.isActive == true) return
        streams[id] = scope.launch {
            var cursor: String? = null
            while (isActive) {
                try {
                    repository.workspaceEvents(cursor).collect { frame ->
                        event(id, "open")
                        when (frame) {
                            is LiveFrame.Change -> {
                                cursor = frame.cursor.toString()
                                event(id, "change", JSONObject().put("cursor", frame.cursor).put("privacyEpoch", frame.privacyEpoch)
                                    .put("coreId", frame.coreId).put("bootId", frame.bootId).put("reset", frame.reset).toString())
                            }
                            LiveFrame.Revoked -> event(id, "revoked", "{}")
                            is LiveFrame.Unknown -> Unit
                        }
                    }
                } catch (failure: Exception) { if (failure is CancellationException) throw failure }
                event(id, "error")
                delay(3_000)
            }
        }
    }
    fun selectBot(id: String) {
        pendingBot = id
        if (loaded) web.evaluateJavascript("window.dispatchEvent(new CustomEvent('nex-android-agent',{detail:${JSONObject.quote(id)}}))", null)
    }
    fun pause() { active = false; streams.values.forEach { it.cancel() }; streams.clear(); web.onPause(); web.pauseTimers() }
    fun resume() { active = true; web.resumeTimers(); web.onResume(); subscriptions.toList().forEach(::startStream); web.evaluateJavascript("window.dispatchEvent(new Event('focus'))", null) }
    fun close() { closed = true; updater.stop(); scope.cancel(); fileCallback?.onReceiveValue(null); save = null; web.resumeTimers(); web.stopLoading(); web.removeJavascriptInterface("NexAndroid"); web.destroy() }
}

internal fun openWorkspaceExternal(context: Context, url: String) {
    val uri = Uri.parse(url)
    require(uri.scheme in listOf("https", "http") && !uri.host.isNullOrBlank() && uri.userInfo.isNullOrEmpty()) { "链接无效" }
    try { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
    catch (_: Exception) { throw IllegalStateException("无法打开浏览器，请重试") }
}
