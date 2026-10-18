package com.nexorai.nexbot.data

import android.content.Context
import com.nexorai.nexbot.core.CoreJson
import kotlinx.serialization.Serializable

/**
 * One saved Core + session. The token is the only secret; it is sealed by
 * [SecretBox] before it touches shared preferences.
 */
@Serializable
data class StoredConnection(
    val origin: String = "",
    val publicCoreId: String = "",
    val workspaceCoreId: String = "",
    val name: String = "",
    val account: String = "",
    val token: String = "",
    val sessionId: String = "",
    val expiresAt: Long = 0,
)

interface ConnectionStore {
    fun load(): StoredConnection?

    fun save(connection: StoredConnection)

    fun clear()
}

/** Seals bytes at rest. Android implementation is the Keystore; tests use a fake. */
interface SecretBox {
    fun seal(plain: String): String

    fun open(sealed: String): String?
}

class PrefsConnectionStore(context: Context, private val box: SecretBox) : ConnectionStore {
    private val prefs = context.getSharedPreferences("nexbot", Context.MODE_PRIVATE)

    override fun load(): StoredConnection? {
        val sealed = prefs.getString(KEY, null) ?: return null
        val plain = box.open(sealed) ?: run {
            // A key rotated away or a corrupt record: forget it rather than
            // looping on a connection nobody can read.
            prefs.edit().remove(KEY).apply()
            return null
        }
        return runCatching { CoreJson.decodeFromString(StoredConnection.serializer(), plain) }.getOrNull()
    }

    override fun save(connection: StoredConnection) {
        val plain = CoreJson.encodeToString(StoredConnection.serializer(), connection)
        prefs.edit().putString(KEY, box.seal(plain)).apply()
    }

    override fun clear() {
        prefs.edit().remove(KEY).apply()
    }

    private companion object {
        const val KEY = "connection"
    }
}
