package com.example.hybriddebug

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.charset.StandardCharsets

/**
 * Owns the on-device bundle directory and the active/previous pointers.
 *
 * ```
 * files/hybrid-debug/
 *   active                  "v2"
 *   previous                "v1"
 *   versions/v1/...         extracted bundle
 *   versions/v2/...
 *   tmp/                    downloads and staging
 * ```
 */
internal class BundleStore(context: Context) {

    private val root = File(context.filesDir, "hybrid-debug")
    private val versionsDir = File(root, "versions")
    private val tmpDir = File(root, "tmp")
    private val activeFile = File(root, "active")
    private val previousFile = File(root, "previous")

    @Synchronized
    fun getActiveVersion(): String? =
        readText(activeFile)?.takeIf { isValidVersion(it) }

    @Synchronized
    fun getPreviousVersion(): String? =
        readText(previousFile)?.takeIf { isValidVersion(it) }

    fun getVersionDir(version: String?): File? {
        if (!isValidVersion(version)) return null
        return File(versionsDir, version!!)
    }

    fun getActiveDir(): File? {
        val version = getActiveVersion() ?: return null
        val dir = getVersionDir(version) ?: return null
        return if (dir.isDirectory) dir else null
    }

    @Throws(IOException::class)
    fun createStagingDir(version: String): File {
        if (!isValidVersion(version)) throw IOException("非法版本号")
        ensureDir(tmpDir)
        val staging = File(tmpDir, "staging-$version-${System.currentTimeMillis()}")
        deleteRecursively(staging)
        if (!staging.mkdirs()) throw IOException("无法创建 staging 目录")
        return staging
    }

    @Throws(IOException::class)
    fun createTempZip(): File {
        ensureDir(tmpDir)
        return File.createTempFile("download-", ".zip", tmpDir)
    }

    /** Marks a fully verified directory as active, remembering the old one. */
    @Synchronized
    @Throws(IOException::class)
    fun activate(version: String) {
        if (!isValidVersion(version)) throw IOException("非法版本号")
        val dir = getVersionDir(version)
        if (dir == null || !dir.isDirectory) {
            throw IOException("版本目录不存在：$version")
        }

        val current = getActiveVersion()
        if (current != null && current != version) {
            writeText(previousFile, current)
        }
        writeText(activeFile, version)
    }

    /** Swaps active and previous. Returns the newly active version, or null. */
    @Synchronized
    @Throws(IOException::class)
    fun rollback(): String? {
        val active = getActiveVersion()
        val previous = getPreviousVersion() ?: return null
        val previousDir = getVersionDir(previous)
        if (previousDir == null || !previousDir.isDirectory) {
            return null
        }

        writeText(activeFile, previous)
        if (active != null) {
            writeText(previousFile, active)
        }
        return previous
    }

    @Synchronized
    fun clearAll() {
        deleteRecursively(root)
    }

    /**
     * Replaces a version directory with the verified staging directory.
     * Both are under files/, so this is a same-filesystem rename.
     */
    @Synchronized
    @Throws(IOException::class)
    fun commit(version: String, staging: File) {
        if (!isValidVersion(version)) throw IOException("非法版本号")
        ensureDir(versionsDir)
        val target = File(versionsDir, version)
        deleteRecursively(target)
        if (!staging.renameTo(target)) {
            throw IOException("无法激活下载包（rename 失败）")
        }
        activate(version)
    }

    companion object {
        private val VERSION = Regex("^[A-Za-z0-9._-]{1,80}$")

        fun isValidVersion(version: String?): Boolean =
            version != null && VERSION.matches(version)

        fun deleteRecursively(file: File?) {
            if (file == null || !file.exists()) return
            file.listFiles()?.forEach { deleteRecursively(it) }
            // Best effort: cache directories can sometimes refuse deletion.
            file.delete()
        }

        @Throws(IOException::class)
        private fun ensureDir(dir: File) {
            if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) {
                throw IOException("无法创建目录：${dir.name}")
            }
        }

        private fun readText(file: File): String? {
            if (!file.isFile) return null
            return try {
                FileInputStream(file).use { input ->
                    val buffer = ByteArray(minOf(file.length(), 4096L).toInt())
                    val read = input.read(buffer)
                    if (read <= 0) {
                        null
                    } else {
                        String(buffer, 0, read, StandardCharsets.UTF_8).trim()
                    }
                }
            } catch (_: IOException) {
                null
            }
        }

        @Throws(IOException::class)
        private fun writeText(file: File, text: String) {
            val atomic = AtomicFile(file)
            val out = atomic.startWrite()
            try {
                out.write(text.toByteArray(StandardCharsets.UTF_8))
                out.flush()
                atomic.finishWrite(out)
            } catch (err: IOException) {
                atomic.failWrite(out)
                throw err
            }
        }
    }
}
