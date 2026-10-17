package com.nexorai.nexbot.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-GCM under a non-exportable Android Keystore key. Every save uses a fresh
 * IV, which is stored in front of the ciphertext; the key never leaves the
 * Keystore and the file is not backed up (the manifest disables backup).
 */
class KeystoreSecretBox : SecretBox {
    override fun seal(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ciphertext = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val packed = cipher.iv + ciphertext
        return Base64.encodeToString(packed, Base64.NO_WRAP)
    }

    override fun open(sealed: String): String? = runCatching {
        val packed = Base64.decode(sealed, Base64.NO_WRAP)
        if (packed.size <= IV_BYTES) return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, packed, 0, IV_BYTES))
        String(cipher.doFinal(packed, IV_BYTES, packed.size - IV_BYTES), Charsets.UTF_8)
    }.getOrNull()

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
        const val ALIAS = "nexbot-connection"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
