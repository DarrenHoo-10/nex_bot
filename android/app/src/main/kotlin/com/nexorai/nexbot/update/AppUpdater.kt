package com.nexorai.nexbot.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.nexorai.nexbot.core.ClientUpdates
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/**
 * Checks the signed-in Core for a newer APK after sign-in and every six hours,
 * downloads it in the background and offers it only once its digest matches.
 */
class AppUpdater(private val context: Context, origin: String, private val onState: (JSONObject) -> Unit) {
    private val updates = ClientUpdates(origin)
    private val dir = File(context.cacheDir, "updates")
    private val current = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty()
    private var job: Job? = null
    private var ready: File? = null
    @Volatile var state: JSONObject = JSONObject().put("status", "idle").put("current", current)
        private set

    fun start(scope: CoroutineScope) {
        if (job?.isActive == true) return
        job = scope.launch {
            while (isActive) {
                check()
                delay(6 * 60 * 60_000L)
            }
        }
    }

    fun stop() { job?.cancel(); job = null }

    private suspend fun check() {
        try {
            val offer = withContext(Dispatchers.IO) { updates.check("android", current) } ?: return
            if (ready != null && state.optString("version") == offer.version) return
            publish(JSONObject().put("status", "downloading").put("current", current).put("version", offer.version))
            val file = withContext(Dispatchers.IO) {
                dir.listFiles().orEmpty().filter { it.name != "nexbot-${offer.version}.apk" }.forEach { it.delete() }
                updates.download(offer, dir, "nexbot-${offer.version}.apk")
            }
            // Only an APK for this app is offered; the installer then checks its signature.
            val archive = context.packageManager.getPackageArchiveInfo(file.path, 0)
            if (archive?.packageName != context.packageName) { file.delete(); throw IllegalStateException("更新文件不属于本应用") }
            ready = file
            publish(JSONObject().put("status", "ready").put("current", current).put("version", offer.version))
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            if (ready == null) publish(JSONObject().put("status", "error").put("current", current).put("error", failure.message ?: "检查更新失败"))
        }
    }

    private suspend fun publish(next: JSONObject) {
        state = next
        withContext(Dispatchers.Main) { onState(next) }
    }

    /** Opens the system installer; asks for the unknown-sources permission first when needed. */
    fun install() {
        val file = checkNotNull(ready?.takeIf { it.isFile }) { "更新尚未就绪" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            throw IllegalStateException("请允许 NexBot 安装应用后再点立即更新")
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
