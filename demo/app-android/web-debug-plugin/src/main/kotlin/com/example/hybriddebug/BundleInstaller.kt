package com.example.hybriddebug

import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.DigestOutputStream
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Locale
import java.util.zip.ZipFile

/**
 * Downloads latest.json and installs the new version.
 *
 * When the active version has a matching signed patch, only changed files are
 * downloaded and merged into a copy of the active version. Any patch failure
 * falls back to the full bundle. Nothing is served until the resulting tree
 * passes per-file verification and is activated atomically.
 */
internal object BundleInstaller {

    private const val TAG = "HybridBundle"
    private const val FORMAT = 1
    private const val MAX_LATEST_BYTES = 1024L * 1024
    private const val MAX_MANIFEST_BYTES = 2L * 1024 * 1024
    private const val MAX_BUNDLE_BYTES = 64L * 1024 * 1024
    private const val MAX_UNCOMPRESSED_BYTES = 128L * 1024 * 1024
    private const val CONNECT_TIMEOUT_MS = 8000
    private const val READ_TIMEOUT_MS = 30000

    data class SyncResult(
        val updated: Boolean,
        val patched: Boolean,
        val version: String,
        val previousVersion: String?,
        val fileCount: Int,
        val changedCount: Int,
        val size: Long,
        val fullSize: Long,
        val message: String,
    )

    private data class ParsedFull(
        val manifestBytes: ByteArray,
        val fileCount: Int,
    )

    @Throws(Exception::class)
    fun install(store: BundleStore, rawBase: String?, token: String?): SyncResult {
        val base = normalizeBase(rawBase)
        if (token.isNullOrBlank()) {
            throw IOException("缺少同步 token")
        }
        val baseUrl = URL(base)

        val latestText = httpGetText(
            URL("$base/latest.json"),
            token,
            "latest.json",
            MAX_LATEST_BYTES,
        )
        val latest = JSONObject(latestText)
        if (latest.optInt("format", -1) != FORMAT) {
            throw IOException("不支持的 bundle 格式")
        }
        val version = latest.getString("version")
        if (!BundleStore.isValidVersion(version)) {
            throw IOException("服务器返回了非法版本号")
        }
        if (DevShellConfig.BUNDLE_KEY_ID != latest.optString("keyId")) {
            throw IOException("未知签名 keyId：${latest.optString("keyId")}")
        }

        val active = store.getActiveVersion()
        val activeDir = store.getActiveDir()
        if (version == active && activeDir != null) {
            val size = latest.optLong("size", 0)
            return SyncResult(
                updated = false,
                patched = false,
                version = version,
                previousVersion = store.getPreviousVersion(),
                fileCount = latest.optInt("fileCount", 0),
                changedCount = 0,
                size = size,
                fullSize = size,
                message = "已是最新包：$version",
            )
        }

        val patches = latest.optJSONObject("patches")
        val patch = if (patches == null || active == null) {
            null
        } else {
            patches.optJSONObject(active)
        }

        var patchFailure: String? = null
        if (patch != null && active != null && activeDir != null) {
            try {
                return installPatch(
                    store,
                    baseUrl,
                    token,
                    latest,
                    version,
                    active,
                    activeDir,
                    patch,
                )
            } catch (err: Exception) {
                Log.w(TAG, "patch install failed, falling back to full bundle", err)
                val message = err.message
                patchFailure = if (message.isNullOrEmpty()) {
                    err.javaClass.simpleName
                } else {
                    message
                }
            }
        }

        return installFull(store, baseUrl, token, latest, version, active, patchFailure)
    }

    @Throws(Exception::class)
    private fun installPatch(
        store: BundleStore,
        baseUrl: URL,
        token: String,
        latest: JSONObject,
        version: String,
        baseVersion: String,
        baseDir: File,
        patch: JSONObject,
    ): SyncResult {
        if (patch.optInt("format", -1) != FORMAT) {
            throw IOException("补丁格式不支持")
        }
        if (version != patch.optString("version")) {
            throw IOException("补丁目标版本和 latest.json 不一致")
        }
        if (baseVersion != patch.optString("baseVersion")) {
            throw IOException("补丁基础版本和当前版本不一致")
        }
        if (DevShellConfig.BUNDLE_KEY_ID != patch.optString("keyId")) {
            throw IOException("未知补丁 keyId")
        }

        val manifestUrl = sameOriginUrl(
            baseUrl,
            patch.getString("manifest"),
            "补丁 manifest",
        )
        val zipUrl = sameOriginUrl(baseUrl, patch.getString("zip"), "补丁 zip")
        val declaredPatchSize = patch.optLong("size", -1)
        val expectedPatchSha = patch.getString("sha256").lowercase(Locale.US)
        val fullSize = patch.optLong("fullSize", latest.optLong("size", -1))

        val patchManifestBytes = httpGetBytes(
            manifestUrl,
            token,
            "补丁 manifest",
            MAX_MANIFEST_BYTES,
        )
        verifySignature(
            patchManifestBytes,
            patch.getString("signature"),
            "补丁 manifest",
        )

        val patchManifest = JSONObject(
            String(patchManifestBytes, StandardCharsets.UTF_8),
        )
        if (patchManifest.optInt("format", -1) != FORMAT) {
            throw IOException("补丁 manifest 格式不支持")
        }
        if (patchManifest.optString("kind") != "patch") {
            throw IOException("补丁 manifest 类型不正确")
        }
        if (version != patchManifest.optString("version")) {
            throw IOException("补丁 manifest 版本不一致")
        }
        if (baseVersion != patchManifest.optString("baseVersion")) {
            throw IOException("补丁 manifest 基础版本不一致")
        }

        val files = patchManifest.getJSONObject("files")
        if (files.length() == 0) {
            throw IOException("补丁 manifest 没有文件")
        }
        if (files.has("manifest.json")) {
            throw IOException("manifest.json 不能出现在 files 里")
        }
        val entry = patchManifest.optString("entry", "index.html")
        if (entry.isEmpty() || !files.has(entry)) {
            throw IOException("入口文件不在补丁 manifest 里")
        }

        val changed = readNameSet(
            patchManifest.getJSONArray("changed"),
            "changed",
        )
        val removed = readNameSet(
            patchManifest.getJSONArray("removed"),
            "removed",
        )
        for (name in changed) {
            if (!files.has(name)) {
                throw IOException("补丁 changed 文件不在目标列表：$name")
            }
        }
        for (name in removed) {
            if (files.has(name)) {
                throw IOException("补丁 removed 文件仍在目标列表：$name")
            }
        }

        val targetNames = HashSet<String>()
        var totalUncompressed = 0L
        val keys = files.keys()
        while (keys.hasNext()) {
            val name = safeZipName(keys.next())
            if (name == "manifest.json") {
                throw IOException("manifest.json 不能出现在 files 里")
            }
            if (!targetNames.add(name)) {
                throw IOException("补丁 manifest 含重复文件：$name")
            }
            totalUncompressed += checkedSize(files.getJSONObject(name), name)
            if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
                throw IOException("目标 bundle 解压后过大")
            }
        }

        var tempZip: File? = null
        var stagingToCleanup: File? = null
        try {
            val patchZipFile = store.createTempZip()
            tempZip = patchZipFile
            val actualPatchSize = httpDownload(
                zipUrl,
                token,
                patchZipFile,
                MAX_BUNDLE_BYTES,
                "补丁 zip",
            )
            if (declaredPatchSize >= 0 && actualPatchSize != declaredPatchSize) {
                throw IOException("补丁 zip 大小校验失败")
            }
            if (sha256File(patchZipFile) != expectedPatchSha) {
                throw IOException("补丁 zip SHA-256 校验失败")
            }

            val staging = store.createStagingDir(version)
            stagingToCleanup = staging

            // Reuse every unchanged target file from the active version.
            for (name in targetNames) {
                if (name in changed) continue
                val info = files.getJSONObject(name)
                val expectedSize = checkedSize(info, name)
                val source = resolveInside(baseDir, name)
                if (!source.isFile) {
                    throw IOException("基础版本缺少文件：$name")
                }
                val output = resolveInside(staging, name)
                ensureParent(output, name)
                BufferedInputStream(FileInputStream(source)).use { input ->
                    FileOutputStream(output).use { out ->
                        val written = copyLimited(input, out, expectedSize)
                        if (written != expectedSize) {
                            throw IOException("基础版本文件大小不一致：$name")
                        }
                    }
                }
            }

            // Extract only the files declared as changed in the signed manifest.
            val extracted = HashSet<String>()
            ZipFile(patchZipFile).use { zip ->
                val entries = zip.entries()
                while (entries.hasMoreElements()) {
                    val zipEntry = entries.nextElement()
                    if (zipEntry.isDirectory) continue
                    val name = safeZipName(zipEntry.name)
                    if (name !in changed) {
                        throw IOException("补丁含未声明的文件：$name")
                    }
                    if (!extracted.add(name)) {
                        throw IOException("补丁含重复文件：$name")
                    }

                    val info = files.optJSONObject(name)
                        ?: throw IOException("补丁文件不在目标列表：$name")
                    val expectedSize = checkedSize(info, name)
                    val expectedHash = info.getString("sha256").lowercase(Locale.US)

                    val output = resolveInside(staging, name)
                    ensureParent(output, name)
                    val digest = MessageDigest.getInstance("SHA-256")
                    val written = zip.getInputStream(zipEntry).use { input ->
                        DigestOutputStream(
                            BufferedOutputStream(FileOutputStream(output)),
                            digest,
                        ).use { out ->
                            copyLimited(input, out, expectedSize)
                        }
                    }
                    if (written != expectedSize) {
                        throw IOException("补丁文件大小校验失败：$name")
                    }
                    if (toHex(digest.digest()) != expectedHash) {
                        throw IOException("补丁文件 SHA-256 校验失败：$name")
                    }
                }
            }
            if (extracted != changed) {
                val missing = HashSet(changed)
                missing.removeAll(extracted)
                throw IOException("补丁缺少文件：$missing")
            }

            // Verify the complete result, including files copied from the base.
            for (name in targetNames) {
                verifyFile(
                    resolveInside(staging, name),
                    files.getJSONObject(name),
                    name,
                )
            }

            FileOutputStream(File(staging, "manifest.json")).use { out ->
                out.write(patchManifestBytes)
            }

            store.commit(version, staging)
            stagingToCleanup = null // renamed into versions/<version>; do not delete

            val fileCount = files.length()
            val saved = if (fullSize > actualPatchSize) {
                fullSize - actualPatchSize
            } else {
                0
            }
            val sizeText = if (fullSize > 0) {
                humanSize(actualPatchSize) + "；完整包 " + humanSize(fullSize) +
                    (if (saved > 0) "，节省 " + humanSize(saved) else "")
            } else {
                humanSize(actualPatchSize)
            }
            val removedText = if (removed.isEmpty()) "" else "，删除 ${removed.size} 个"

            val message = "已应用补丁 $version（${changed.size} 个变化文件" +
                "$removedText，" + "$sizeText）" + "；上一版 $baseVersion"
            Log.i(TAG, message)
            return SyncResult(
                updated = true,
                patched = true,
                version = version,
                previousVersion = baseVersion,
                fileCount = fileCount,
                changedCount = changed.size,
                size = actualPatchSize,
                fullSize = fullSize,
                message = message,
            )
        } finally {
            tempZip?.delete()
            stagingToCleanup?.let { BundleStore.deleteRecursively(it) }
        }
    }

    @Throws(Exception::class)
    private fun installFull(
        store: BundleStore,
        baseUrl: URL,
        token: String,
        latest: JSONObject,
        version: String,
        active: String?,
        patchFailure: String?,
    ): SyncResult {
        val zipUrl = sameOriginUrl(baseUrl, latest.getString("bundle"), "bundle")
        val expectedZipSha = latest.getString("sha256").lowercase(Locale.US)
        val signature = latest.getString("signature")
        val declaredZipSize = latest.optLong("size", -1)
        val fullSize = declaredZipSize

        var tempZip: File? = null
        var stagingToCleanup: File? = null
        try {
            val zipFile = store.createTempZip()
            tempZip = zipFile
            val actualZipSize = httpDownload(
                zipUrl,
                token,
                zipFile,
                MAX_BUNDLE_BYTES,
                "bundle.zip",
            )
            if (declaredZipSize >= 0 && declaredZipSize != actualZipSize) {
                throw IOException("zip 大小校验失败")
            }
            if (sha256File(zipFile) != expectedZipSha) {
                throw IOException("zip SHA-256 校验失败")
            }

            val staging = store.createStagingDir(version)
            stagingToCleanup = staging

            val parsed = ZipFile(zipFile).use { zip ->
                val manifestEntry = zip.getEntry("manifest.json")
                    ?: throw IOException("bundle 里缺少 manifest.json")
                if (manifestEntry.size > MAX_MANIFEST_BYTES) {
                    throw IOException("manifest 过大")
                }
                val manifestBytes = readAll(
                    zip.getInputStream(manifestEntry),
                    MAX_MANIFEST_BYTES,
                )
                verifySignature(manifestBytes, signature, "manifest")

                val manifest = JSONObject(
                    String(manifestBytes, StandardCharsets.UTF_8),
                )
                if (manifest.optInt("format", -1) != FORMAT) {
                    throw IOException("manifest 格式不支持")
                }
                if (version != manifest.optString("version")) {
                    throw IOException("manifest 版本和 latest.json 不一致")
                }
                val files = manifest.getJSONObject("files")
                if (files.has("manifest.json")) {
                    throw IOException("manifest.json 不能出现在 files 里")
                }
                val entry = manifest.optString("entry", "index.html")
                if (entry.isEmpty() || !files.has(entry)) {
                    throw IOException("入口文件不在 manifest 里")
                }

                val fileCount = files.length()
                var totalUncompressed = 0L
                val extracted = HashSet<String>()
                val entries = zip.entries()
                while (entries.hasMoreElements()) {
                    val zipEntry = entries.nextElement()
                    if (zipEntry.isDirectory) continue
                    val name = safeZipName(zipEntry.name)
                    if (name == "manifest.json") continue

                    val info = files.optJSONObject(name)
                        ?: throw IOException("bundle 含 manifest 之外的文件：$name")
                    if (!extracted.add(name)) {
                        throw IOException("bundle 含重复文件：$name")
                    }

                    val expectedSize = checkedSize(info, name)
                    totalUncompressed += expectedSize
                    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
                        throw IOException("bundle 解压后过大")
                    }
                    val expectedHash = info.getString("sha256").lowercase(Locale.US)

                    val output = resolveInside(staging, name)
                    ensureParent(output, name)
                    val digest = MessageDigest.getInstance("SHA-256")
                    val written = zip.getInputStream(zipEntry).use { input ->
                        DigestOutputStream(
                            BufferedOutputStream(FileOutputStream(output)),
                            digest,
                        ).use { out ->
                            copyLimited(input, out, expectedSize)
                        }
                    }
                    if (written != expectedSize) {
                        throw IOException("文件大小校验失败：$name")
                    }
                    if (toHex(digest.digest()) != expectedHash) {
                        throw IOException("文件 SHA-256 校验失败：$name")
                    }
                }

                if (extracted.size != fileCount) {
                    throw IOException(
                        "bundle 缺少文件：manifest 有 $fileCount 个，" +
                            "实际 ${extracted.size} 个",
                    )
                }

                ParsedFull(manifestBytes, fileCount)
            }

            FileOutputStream(File(staging, "manifest.json")).use { out ->
                out.write(parsed.manifestBytes)
            }

            store.commit(version, staging)
            stagingToCleanup = null // renamed into versions/<version>; do not delete

            var message = "已应用 $version（完整包，${parsed.fileCount} 个文件，" +
                "${humanSize(actualZipSize)}）"
            if (active != null) {
                message += "；上一版 $active"
            }
            if (patchFailure != null) {
                message += "（增量补丁失败，已回退完整包：" +
                    shorten(patchFailure, 80) + "）"
            }
            Log.i(TAG, message)
            return SyncResult(
                updated = true,
                patched = false,
                version = version,
                previousVersion = active,
                fileCount = parsed.fileCount,
                changedCount = 0,
                size = actualZipSize,
                fullSize = fullSize,
                message = message,
            )
        } finally {
            tempZip?.delete()
            stagingToCleanup?.let { BundleStore.deleteRecursively(it) }
        }
    }

    @Throws(IOException::class)
    private fun normalizeBase(raw: String?): String {
        var base = raw?.trim() ?: ""
        if (base.isEmpty()) throw IOException("请填写同步服务器地址")
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            base = "http://$base"
        }
        while (base.endsWith("/")) base = base.substring(0, base.length - 1)
        val parsed = URL(base)
        if (parsed.host.isNullOrEmpty()) {
            throw IOException("同步服务器地址无效")
        }
        return base
    }

    @Throws(IOException::class)
    private fun sameOriginUrl(baseUrl: URL, relative: String?, label: String): URL {
        var path = relative?.trim() ?: ""
        if (path.startsWith("/")) path = path.substring(1)
        if (path.isEmpty() ||
            path.contains("..") ||
            path.contains("://") ||
            path.contains("\\")
        ) {
            throw IOException("$label 路径非法")
        }
        var base = baseUrl.toString()
        while (base.endsWith("/")) base = base.substring(0, base.length - 1)
        val url = URL("$base/$path")
        if (!baseUrl.protocol.equals(url.protocol, ignoreCase = true) ||
            !baseUrl.authority.equals(url.authority, ignoreCase = true)
        ) {
            throw IOException("$label 必须和同步服务器同源")
        }
        return url
    }

    @Throws(IOException::class)
    private fun safeZipName(raw: String): String {
        val name = raw.replace('\\', '/')
        if (name.isEmpty() ||
            name.startsWith("/") ||
            name == ".." ||
            name.startsWith("../") ||
            name.contains("/../") ||
            name.contains("\u0000")
        ) {
            throw IOException("bundle 含非法路径：$raw")
        }
        return name
    }

    @Throws(IOException::class)
    private fun resolveInside(root: File, name: String): File {
        val file = File(root, name)
        val rootPath = root.canonicalPath + File.separator
        if (!file.canonicalPath.startsWith(rootPath)) {
            throw IOException("bundle 路径越界：$name")
        }
        return file
    }

    @Throws(IOException::class)
    private fun ensureParent(file: File, name: String) {
        val parent = file.parentFile
        if (parent != null && !parent.isDirectory && !parent.mkdirs()) {
            throw IOException("无法创建目录：$name")
        }
    }

    @Throws(Exception::class)
    private fun readNameSet(array: JSONArray, label: String): Set<String> {
        val out = HashSet<String>()
        for (i in 0 until array.length()) {
            val name = safeZipName(array.getString(i))
            if (!out.add(name)) {
                throw IOException("补丁 $label 含重复文件：$name")
            }
        }
        return out
    }

    @Throws(Exception::class)
    private fun checkedSize(info: JSONObject, name: String): Long {
        val size = info.getLong("size")
        if (size < 0 || size > MAX_UNCOMPRESSED_BYTES) {
            throw IOException("文件大小非法：$name")
        }
        return size
    }

    @Throws(Exception::class)
    private fun verifyFile(file: File, info: JSONObject, name: String) {
        if (!file.isFile) {
            throw IOException("缺少文件：$name")
        }
        val expectedSize = checkedSize(info, name)
        if (file.length() != expectedSize) {
            throw IOException("文件大小校验失败：$name")
        }
        val expectedHash = info.getString("sha256").lowercase(Locale.US)
        if (sha256File(file) != expectedHash) {
            throw IOException("文件 SHA-256 校验失败：$name")
        }
    }

    @Throws(Exception::class)
    private fun verifySignature(
        data: ByteArray,
        signatureBase64: String,
        label: String,
    ) {
        val publicKeyBytes = Base64.decode(
            DevShellConfig.BUNDLE_PUBLIC_KEY_BASE64,
            Base64.DEFAULT,
        )
        val publicKey = KeyFactory.getInstance("EC").generatePublic(
            X509EncodedKeySpec(publicKeyBytes),
        )
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(publicKey)
        verifier.update(data)
        val ok = try {
            verifier.verify(Base64.decode(signatureBase64, Base64.DEFAULT))
        } catch (_: Exception) {
            false
        }
        if (!ok) throw IOException("$label 签名校验失败")
    }

    @Throws(IOException::class)
    private fun httpGetText(
        url: URL,
        token: String,
        label: String,
        maxBytes: Long,
    ): String = String(httpGetBytes(url, token, label, maxBytes), StandardCharsets.UTF_8)

    @Throws(IOException::class)
    private fun httpGetBytes(
        url: URL,
        token: String,
        label: String,
        maxBytes: Long,
    ): ByteArray {
        val conn = openConnection(url, token, "application/json")
        try {
            val status = conn.responseCode
            if (status != 200) {
                throw IOException("$label 返回 HTTP $status" + errorSnippet(conn))
            }
            conn.inputStream.use { input ->
                return readAll(input, maxBytes)
            }
        } finally {
            conn.disconnect()
        }
    }

    @Throws(IOException::class)
    private fun httpDownload(
        url: URL,
        token: String,
        destination: File,
        maxBytes: Long,
        label: String,
    ): Long {
        val conn = openConnection(url, token, "application/zip")
        try {
            val status = conn.responseCode
            if (status != 200) {
                throw IOException("$label 返回 HTTP $status" + errorSnippet(conn))
            }
            val contentLength = conn.contentLengthLong
            if (contentLength > maxBytes) {
                throw IOException("$label 超过大小上限")
            }

            var total = 0L
            val buffer = ByteArray(16 * 1024)
            BufferedInputStream(conn.inputStream).use { input ->
                FileOutputStream(destination).use { out ->
                    var read = input.read(buffer)
                    while (read != -1) {
                        total += read
                        if (total > maxBytes) {
                            throw IOException("$label 超过大小上限")
                        }
                        out.write(buffer, 0, read)
                        read = input.read(buffer)
                    }
                    out.flush()
                }
            }
            return total
        } finally {
            conn.disconnect()
        }
    }

    @Throws(IOException::class)
    private fun openConnection(
        url: URL,
        token: String,
        accept: String,
    ): HttpURLConnection = (url.openConnection() as HttpURLConnection).apply {
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        requestMethod = "GET"
        setRequestProperty("accept", accept)
        setRequestProperty("x-sync-token", token)
        useCaches = false
    }

    @Throws(IOException::class)
    private fun copyLimited(input: InputStream, out: OutputStream, limit: Long): Long {
        val buffer = ByteArray(16 * 1024)
        var total = 0L
        var read = input.read(buffer)
        while (read != -1) {
            total += read
            if (total > limit) {
                throw IOException("解压文件超过声明大小")
            }
            out.write(buffer, 0, read)
            read = input.read(buffer)
        }
        out.flush()
        return total
    }

    @Throws(IOException::class)
    private fun readAll(input: InputStream, limit: Long): ByteArray =
        input.use { stream ->
            ByteArrayOutputStream().use { out ->
                val buffer = ByteArray(8192)
                var total = 0L
                var read = stream.read(buffer)
                while (read != -1) {
                    total += read
                    if (total > limit) throw IOException("服务器响应过大")
                    out.write(buffer, 0, read)
                    read = stream.read(buffer)
                }
                out.toByteArray()
            }
        }

    @Throws(Exception::class)
    private fun sha256File(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        BufferedInputStream(FileInputStream(file)).use { input ->
            val buffer = ByteArray(16 * 1024)
            var read = input.read(buffer)
            while (read != -1) {
                digest.update(buffer, 0, read)
                read = input.read(buffer)
            }
        }
        return toHex(digest.digest())
    }

    private fun toHex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            out.append(String.format(Locale.US, "%02x", b.toInt() and 0xff))
        }
        return out.toString()
    }

    private fun errorSnippet(conn: HttpURLConnection): String {
        val err = conn.errorStream ?: return ""
        return try {
            val data = readAll(err, 512)
            val text = String(data, StandardCharsets.UTF_8).trim()
            if (text.isEmpty()) "" else "：$text"
        } catch (_: IOException) {
            ""
        }
    }

    private fun shorten(text: String?, max: Int): String {
        val oneLine = (text ?: "").replace('\n', ' ').trim()
        return if (oneLine.length <= max) oneLine else oneLine.substring(0, max) + "…"
    }

    private fun humanSize(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        if (bytes < 1024 * 1024) {
            return String.format(Locale.US, "%.1f KiB", bytes / 1024.0)
        }
        return String.format(Locale.US, "%.1f MiB", bytes / (1024.0 * 1024.0))
    }
}
