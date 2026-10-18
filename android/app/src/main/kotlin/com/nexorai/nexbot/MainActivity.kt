package com.nexorai.nexbot

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.nexorai.nexbot.notifications.NotificationNotifier
import com.nexorai.nexbot.ui.NexBotRoot
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val repository get() = (application as NexBotApp).repository

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /**
     * A phone that was dark while Core finished a turn must resync the moment
     * the screen comes back, not wait for the next poll: backgrounding closes
     * the stream on purpose (no closed-app push in v1), so waking is the first
     * chance to catch up.
     */
    private val screenOn = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> {
                    repository.setForeground(true)
                    repository.retry()
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { NexBotRoot(repository) }
        lifecycleScope.launch { repository.start() }
        askForNotifications()
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        registerReceiver(
            screenOn,
            IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_ON)
                addAction(Intent.ACTION_USER_PRESENT)
            },
        )
        repository.setForeground(true)
    }

    override fun onStop() {
        unregisterReceiver(screenOn)
        super.onStop()
        repository.setForeground(false)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val botId = intent?.getStringExtra(NotificationNotifier.EXTRA_BOT) ?: return
        intent.removeExtra(NotificationNotifier.EXTRA_BOT)
        repository.openBotWhenReady(botId)
    }

    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}
