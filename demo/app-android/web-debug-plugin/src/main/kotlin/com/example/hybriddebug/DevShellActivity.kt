package com.example.hybriddebug

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * DevShell: a development-only wrapper around the production WebView.
 *
 * It downloads a signed bundle over the LAN, activates it atomically, and
 * serves its static files while the WebView URL stays on the production origin.
 */
class DevShellActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var prodInput: EditText
    private lateinit var serverInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var statusView: TextView
    private lateinit var activeBadge: TextView
    private lateinit var devPanel: View
    private lateinit var togglePanelButton: Button
    private lateinit var syncButton: Button
    private lateinit var rollbackButton: Button
    private lateinit var localButton: Button
    private lateinit var prodButton: Button
    private lateinit var clearButton: Button

    private lateinit var store: BundleStore
    private lateinit var webViewClient: LocalBundleWebViewClient
    private lateinit var prefs: SharedPreferences
    private lateinit var executor: ExecutorService
    private var localMode = false
    private var syncing = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_dev_shell)

        store = BundleStore(this)
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        executor = Executors.newSingleThreadExecutor()

        bindViews()
        restoreConfig()

        val autoSync = applyPairIntent(intent)
        setupWebView()
        setupButtons()

        localMode = store.getActiveVersion() != null
        refreshBadge()
        if (localMode) {
            setStatus("已安装本地包 ${store.getActiveVersion()}，准备加载")
        } else {
            setStatus("还没有本地包，准备加载生产页")
        }

        if (autoSync) {
            statusView.text = "已收到配对信息，正在同步…"
            webView.postDelayed({ syncNow() }, 250)
        } else {
            loadPage(false)
        }
    }

    public override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val autoSync = applyPairIntent(intent)
        if (autoSync) {
            syncNow()
        } else {
            loadPage(false)
        }
    }

    private fun bindViews() {
        webView = findViewById(R.id.web_view)
        prodInput = findViewById(R.id.prod_input)
        serverInput = findViewById(R.id.server_input)
        tokenInput = findViewById(R.id.token_input)
        statusView = findViewById(R.id.status_view)
        activeBadge = findViewById(R.id.active_badge)
        devPanel = findViewById(R.id.dev_panel)
        togglePanelButton = findViewById(R.id.toggle_panel_button)
        syncButton = findViewById(R.id.sync_button)
        rollbackButton = findViewById(R.id.rollback_button)
        localButton = findViewById(R.id.local_button)
        prodButton = findViewById(R.id.prod_button)
        clearButton = findViewById(R.id.clear_button)
        statusView.movementMethod = ScrollingMovementMethod()
    }

    private fun restoreConfig() {
        prodInput.setText(prefs.getString(KEY_PROD, DevShellConfig.DEFAULT_PROD_URL))
        serverInput.setText(prefs.getString(KEY_SERVER, DevShellConfig.DEFAULT_SYNC_URL))
        tokenInput.setText(prefs.getString(KEY_TOKEN, DevShellConfig.DEFAULT_SYNC_TOKEN))
    }

    /**
     * Supports hybriddemo-dev://sync?server=...&token=...&prod=...&auto=1
     * The desktop console puts this URL in a QR code.
     */
    private fun applyPairIntent(intent: Intent?): Boolean {
        if (intent == null) return false
        val data = intent.data ?: return false
        if (data.scheme != "hybriddemo-dev" || data.host != "sync") {
            return false
        }

        val server = data.getQueryParameter("server")
        val token = data.getQueryParameter("token")
        val prod = data.getQueryParameter("prod")
        if (!server.isNullOrBlank()) serverInput.setText(server.trim())
        if (!token.isNullOrBlank()) tokenInput.setText(token.trim())
        if (!prod.isNullOrBlank()) prodInput.setText(prod.trim())
        val auto = data.getQueryParameter("auto")
        Log.i(
            TAG,
            "pair received, auto=$auto, params=${data.queryParameterNames}",
        )
        saveConfig(true)
        setStatus("已从扫码/深链收到同步配置")
        return auto == "1" || "true".equals(auto, ignoreCase = true)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
        settings.userAgentString =
            settings.userAgentString + DevShellConfig.USER_AGENT_SUFFIX

        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(webView, true)

        // DevShell only. Production flavor does not include this plugin.
        WebView.setWebContentsDebuggingEnabled(true)

        webViewClient = LocalBundleWebViewClient(
            store,
            normalizeProd(prodInput.text.toString()),
            object : LocalBundleWebViewClient.Listener {
                override fun onPageFinished(url: String) {
                    runOnUiThread { refreshBadge() }
                }

                override fun onPageError(message: String) {
                    runOnUiThread { setStatus("页面加载失败：$message") }
                }
            },
        )
        webView.webViewClient = webViewClient
        webView.setBackgroundColor(0xFF07111D.toInt())
    }

    private fun setupButtons() {
        syncButton.setOnClickListener { syncNow() }
        rollbackButton.setOnClickListener { rollback() }
        localButton.setOnClickListener {
            if (store.getActiveVersion() == null) {
                setStatus("还没有本地包，先点「同步最新包」")
                return@setOnClickListener
            }
            localMode = true
            loadPage(true)
            setStatus("本地包模式：${store.getActiveVersion()}")
        }
        prodButton.setOnClickListener {
            localMode = false
            loadPage(true)
            setStatus("生产模式：静态资源来自生产服务器")
        }
        clearButton.setOnClickListener { clearBundles() }
        togglePanelButton.setOnClickListener {
            val visible = devPanel.visibility == View.VISIBLE
            devPanel.visibility = if (visible) View.GONE else View.VISIBLE
            togglePanelButton.text = if (visible) "展开" else "收起"
        }
    }

    private fun syncNow() {
        if (syncing) return
        val server = serverInput.text.toString().trim()
        val token = tokenInput.text.toString().trim()
        if (server.isEmpty()) {
            setStatus("请填写同步服务器地址")
            return
        }
        if (token.isEmpty()) {
            setStatus("请填写同步 token")
            return
        }

        saveConfig(false)
        syncing = true
        setButtonsEnabled(false)
        setStatus("正在检查更新…")

        executor.execute {
            try {
                val result = BundleInstaller.install(store, server, token)
                runOnUiThread {
                    syncing = false
                    setButtonsEnabled(true)
                    if (isFinishing) return@runOnUiThread
                    localMode = store.getActiveVersion() != null
                    refreshBadge()
                    setStatus(result.message)
                    if (result.updated) {
                        webView.clearCache(true)
                    }
                    loadPage(false)
                    Toast.makeText(this, result.message, Toast.LENGTH_SHORT).show()
                }
            } catch (err: Exception) {
                Log.w(TAG, "bundle sync failed", err)
                runOnUiThread {
                    syncing = false
                    setButtonsEnabled(true)
                    if (isFinishing) return@runOnUiThread
                    val message = if (err.message.isNullOrEmpty()) {
                        err.javaClass.simpleName
                    } else {
                        err.message!!
                    }
                    setStatus("同步失败：$message")
                    Toast.makeText(
                        this,
                        "同步失败：$message",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
    }

    private fun rollback() {
        if (syncing) return
        try {
            val version = store.rollback()
            if (version == null) {
                setStatus("没有可回滚的上一版")
                return
            }
            localMode = true
            webView.clearCache(true)
            refreshBadge()
            loadPage(false)
            setStatus("已回滚到 $version")
        } catch (err: Exception) {
            setStatus("回滚失败：${err.message}")
        }
    }

    private fun clearBundles() {
        if (syncing) return
        store.clearAll()
        localMode = false
        webView.clearCache(true)
        refreshBadge()
        loadPage(false)
        setStatus("本地包已清除，当前加载生产页")
    }

    private fun loadPage(clearCache: Boolean) {
        val prod = normalizeProd(prodInput.text.toString())
        prodInput.setText(prod)
        saveConfig(false)

        val active = store.getActiveVersion()
        if (localMode && active == null) {
            localMode = false
            setStatus("本地包不存在，回退到生产页")
        }

        webViewClient.setProductionUrl(prod)
        webViewClient.setEnabled(localMode && active != null)
        if (clearCache) webView.clearCache(true)

        val entryUrl = prod + DevShellConfig.ENTRY_PATH +
            "?token=" + Uri.encode(DevShellConfig.NATIVE_TOKEN)
        // Do not log entryUrl: real query strings can contain auth tokens.
        Log.i(
            TAG,
            "load " + DevShellConfig.ENTRY_PATH +
                " local=" + (localMode && active != null) +
                " version=" + active,
        )
        webView.loadUrl(entryUrl)
        refreshBadge()
    }

    private fun refreshBadge() {
        val active = store.getActiveVersion()
        val previous = store.getPreviousVersion()
        var mode = when {
            localMode && active != null -> "本地包 $active"
            active == null -> "无本地包 · 生产页"
            else -> "生产页"
        }
        if (previous != null) mode += " · 上一版 $previous"
        activeBadge.text = mode
    }

    private fun setStatus(message: String) {
        statusView.text = message
        Log.i(TAG, message)
    }

    private fun setButtonsEnabled(enabled: Boolean) {
        syncButton.isEnabled = enabled
        rollbackButton.isEnabled = enabled
        localButton.isEnabled = enabled
        prodButton.isEnabled = enabled
        clearButton.isEnabled = enabled
    }

    private fun saveConfig(showToast: Boolean) {
        val prod = normalizeProd(prodInput.text.toString())
        prefs.edit()
            .putString(KEY_PROD, prod)
            .putString(KEY_SERVER, serverInput.text.toString().trim())
            .putString(KEY_TOKEN, tokenInput.text.toString().trim())
            .apply()
        if (showToast) {
            Toast.makeText(this, "同步配置已保存", Toast.LENGTH_SHORT).show()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        if (this::executor.isInitialized) executor.shutdownNow()
        if (this::webView.isInitialized) {
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "HybridDevShell"
        private const val PREFS = "hybrid_devshell"
        private const val KEY_PROD = "prod_url"
        private const val KEY_SERVER = "sync_server"
        private const val KEY_TOKEN = "sync_token"

        private fun normalizeProd(raw: String?): String {
            var url = raw?.trim().orEmpty()
            if (url.isEmpty()) url = DevShellConfig.DEFAULT_PROD_URL
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "http://$url"
            }
            while (url.endsWith("/")) url = url.substring(0, url.length - 1)
            return url
        }
    }
}
