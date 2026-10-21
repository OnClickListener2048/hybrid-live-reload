package com.example.hybriddebug

import android.net.Uri
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.Locale

/**
 * Same-origin static mapping:
 *
 * - requests to the production origin are served from the active bundle;
 * - /api, /oauth, /login, /auth pass through to the network;
 * - other hosts pass through;
 * - missing assets fail locally, so a broken bundle is obvious.
 */
internal class LocalBundleWebViewClient(
    private val store: BundleStore,
    productionUrl: String,
    private val listener: Listener?,
) : WebViewClient() {

    interface Listener {
        fun onPageFinished(url: String)
        fun onPageError(message: String)
    }

    @Volatile
    private var prodScheme: String = ""

    @Volatile
    private var prodAuthority: String = ""

    @Volatile
    private var enabled: Boolean = false

    init {
        setProductionUrl(productionUrl)
    }

    fun setProductionUrl(productionUrl: String) {
        val prod = Uri.parse(productionUrl)
        prodScheme = prod.scheme ?: ""
        prodAuthority = prod.authority ?: ""
    }

    fun setEnabled(enabled: Boolean) {
        this.enabled = enabled
    }

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?,
    ): WebResourceResponse? {
        if (!enabled || request == null) return null
        if (!"GET".equals(request.method, ignoreCase = true)) return null

        val uri = request.url ?: return null
        val scheme = uri.scheme
        val authority = uri.authority
        if (scheme == null ||
            authority == null ||
            !scheme.equals(prodScheme, ignoreCase = true) ||
            !authority.equals(prodAuthority, ignoreCase = true)
        ) {
            return null
        }

        var path = uri.path
        if (path.isNullOrEmpty()) path = "/"
        if (isNetworkPath(path)) return null

        val version = store.getActiveVersion() ?: return null
        val root = store.getVersionDir(version)
        if (root == null || !root.isDirectory) return null

        val looksLikeAsset = hasFileExtension(path)
        var file = resolve(root, path)
        if (file == null || !file.isFile) {
            if (looksLikeAsset) {
                return textResponse(
                    404,
                    "Not Found",
                    "Static asset is not in bundle $version: $path",
                )
            }
            file = File(root, "index.html")
            if (!file.isFile) {
                return textResponse(
                    404,
                    "Not Found",
                    "Bundle $version has no index.html",
                )
            }
        }

        return fileResponse(file, version)
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        listener?.onPageFinished(url ?: "")
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?,
    ) {
        if (listener != null && request?.isForMainFrame == true) {
            listener.onPageError(error?.description?.toString() ?: "")
        }
    }

    companion object {
        private fun isNetworkPath(path: String): Boolean =
            path == "/api" ||
                path.startsWith("/api/") ||
                path == "/oauth" ||
                path.startsWith("/oauth/") ||
                path == "/login" ||
                path.startsWith("/login/") ||
                path == "/auth" ||
                path.startsWith("/auth/")

        private fun hasFileExtension(path: String): Boolean {
            val slash = path.lastIndexOf('/')
            val dot = path.lastIndexOf('.')
            return dot > slash && dot < path.length - 1
        }

        private fun resolve(root: File, path: String): File? {
            var relative = path
            while (relative.startsWith("/")) relative = relative.substring(1)
            if (relative.isEmpty()) relative = "index.html"
            return try {
                val candidate = File(root, relative).canonicalFile
                val rootPath = root.canonicalPath + File.separator
                if (!candidate.path.startsWith(rootPath)) null else candidate
            } catch (_: IOException) {
                null
            }
        }

        private fun fileResponse(file: File, version: String): WebResourceResponse {
            val mime = mimeType(file.name)
            val text = mime.startsWith("text/") ||
                mime.startsWith("application/json") ||
                mime.startsWith("application/javascript")
            return try {
                val input: InputStream = FileInputStream(file)
                val headers = HashMap<String, String>()
                headers["Cache-Control"] = "no-store"
                headers["X-Hybrid-Bundle"] = version
                headers["X-Hybrid-Source"] = "local-bundle"
                WebResourceResponse(
                    mime,
                    if (text) "UTF-8" else null,
                    200,
                    "OK",
                    headers,
                    input,
                )
            } catch (err: IOException) {
                textResponse(500, "Bundle Read Error", err.message)
            }
        }

        private fun textResponse(
            status: Int,
            reason: String,
            body: String?,
        ): WebResourceResponse {
            val headers = HashMap<String, String>()
            headers["Cache-Control"] = "no-store"
            headers["X-Hybrid-Source"] = "local-bundle"
            val bytes = (body ?: "").toByteArray(StandardCharsets.UTF_8)
            return WebResourceResponse(
                "text/plain; charset=utf-8",
                "UTF-8",
                status,
                reason,
                headers,
                ByteArrayInputStream(bytes),
            )
        }

        private fun mimeType(name: String): String {
            val lower = name.lowercase(Locale.US)
            if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html"
            if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript"
            if (lower.endsWith(".css")) return "text/css"
            if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json"
            if (lower.endsWith(".svg")) return "image/svg+xml"
            if (lower.endsWith(".png")) return "image/png"
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
            if (lower.endsWith(".gif")) return "image/gif"
            if (lower.endsWith(".webp")) return "image/webp"
            if (lower.endsWith(".ico")) return "image/x-icon"
            if (lower.endsWith(".woff")) return "font/woff"
            if (lower.endsWith(".woff2")) return "font/woff2"
            if (lower.endsWith(".ttf")) return "font/ttf"
            if (lower.endsWith(".wasm")) return "application/wasm"
            if (lower.endsWith(".txt")) return "text/plain"
            return "application/octet-stream"
        }
    }
}
