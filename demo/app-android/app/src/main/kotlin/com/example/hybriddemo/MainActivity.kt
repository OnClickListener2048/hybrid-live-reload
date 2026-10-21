package com.example.hybriddemo

import android.annotation.SuppressLint
import android.app.Activity
import android.content.SharedPreferences
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var urlInput: EditText
    private lateinit var statusView: TextView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.web_view)
        urlInput = findViewById(R.id.url_input)
        statusView = findViewById(R.id.status_view)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(webView, true)

        WebView.setWebContentsDebuggingEnabled(true)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                statusView.text = "已加载：$url"
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (request?.isForMainFrame == true) {
                    statusView.text = "加载失败：${error?.description}"
                }
            }
        }

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        urlInput.setText(prefs.getString(KEY_URL, DEFAULT_URL))

        findViewById<android.view.View>(R.id.load_button)
            .setOnClickListener { loadFromInput() }
        findViewById<android.view.View>(R.id.reload_button)
            .setOnClickListener { webView.reload() }
        findViewById<android.view.View>(R.id.clear_button)
            .setOnClickListener { clearWebData() }

        loadFromInput()
    }

    private fun loadFromInput() {
        var url = urlInput.text.toString().trim()
        if (url.isEmpty()) {
            url = DEFAULT_URL
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://$url"
        }

        urlInput.setText(url)
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putString(KEY_URL, url)
            .apply()

        statusView.text = "正在加载…"
        webView.loadUrl(url)
    }

    private fun clearWebData() {
        val cookies = CookieManager.getInstance()
        cookies.removeAllCookies(null)
        cookies.flush()
        WebStorage.getInstance().deleteAllData()
        webView.clearCache(true)
        webView.clearHistory()
        Toast.makeText(this, "Cookie 与 WebView 缓存已清空", Toast.LENGTH_SHORT).show()
        webView.reload()
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
        if (this::webView.isInitialized) {
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val DEFAULT_URL = "http://10.0.2.2:8080"
        private const val PREFS = "hybrid_demo"
        private const val KEY_URL = "last_url"
    }
}
