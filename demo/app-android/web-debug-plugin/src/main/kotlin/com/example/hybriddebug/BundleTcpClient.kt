package com.example.hybriddebug

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale

/**
 * Minimal client for the custom bundle sync protocol.
 *
 * This intentionally uses a raw Socket instead of HttpURLConnection. Android's
 * cleartext policy is enforced by the HTTP stack (and WebView), not by raw TCP,
 * so this path is not subject to `usesCleartextTraffic`/NetworkSecurityConfig.
 * It is still plaintext on the wire; the SHA-256 checks provide integrity, not
 * confidentiality. Production deployments should put TLS or a VPN underneath.
 *
 * Wire format matches core/bundle-protocol.js:
 *
 * request:  "HBT1" | version | opcode | pathLen | path
 * response: "HBR1" | version | status | reserved | bodyLen | sha256(body) | body
 *
 * This is a development-only transport with no authentication, so the request
 * has no token field.
 */
internal object BundleTcpClient {

    private const val PROTOCOL_VERSION = 2
    private const val OP_GET = 1
    private const val REQUEST_HEADER_SIZE = 10
    private const val RESPONSE_HEADER_SIZE = 48
    private const val MAX_PATH_BYTES = 4096
    private const val MAX_ERROR_BYTES = 64L * 1024
    private const val DEFAULT_PORT = 9090
    private const val CONNECT_TIMEOUT_MS = 8000
    private const val READ_TIMEOUT_MS = 30000

    private val REQUEST_MAGIC = "HBT1".toByteArray(StandardCharsets.US_ASCII)
    private val RESPONSE_MAGIC = "HBR1".toByteArray(StandardCharsets.US_ASCII)

    private const val STATUS_OK = 0
    private const val STATUS_BAD_REQUEST = 1
    private const val STATUS_NOT_FOUND = 2
    private const val STATUS_TOO_LARGE = 3
    private const val STATUS_SERVER_ERROR = 4

    data class Endpoint(val host: String, val port: Int) {
        override fun toString(): String = "tcp://$host:$port"
    }

    private data class ResponseHeader(
        val status: Int,
        val bodyLength: Long,
        val digest: ByteArray,
    )

    /**
     * Accepts tcp://host:port, bare host:port, and older http(s)://host:port
     * links. The HTTP(S) scheme is accepted only for saved demo configs; the
     * transport is always raw TCP.
     */
    @Throws(IOException::class)
    fun parseEndpoint(raw: String?): Endpoint {
        var value = raw?.trim().orEmpty()
        if (value.isEmpty()) throw IOException("请填写同步服务器地址")
        if (!value.contains("://")) value = "tcp://$value"

        val uri = try {
            URI(value)
        } catch (_: Exception) {
            throw IOException("同步服务器地址无效")
        }
        val scheme = uri.scheme?.lowercase(Locale.US)
        if (scheme != "tcp" && scheme != "http" && scheme != "https") {
            throw IOException("同步服务器地址只支持 tcp://host:port")
        }

        val rawHost = uri.host
        if (rawHost.isNullOrBlank()) throw IOException("同步服务器地址无效")
        val host = rawHost.removePrefix("[").removeSuffix("]")
        if (host.isBlank()) throw IOException("同步服务器地址无效")

        val port = if (uri.port == -1) DEFAULT_PORT else uri.port
        if (port !in 1..65535) throw IOException("同步服务器端口无效")
        if (!uri.path.isNullOrEmpty() && uri.path != "/") {
            throw IOException("同步服务器地址不能带路径")
        }
        if (!uri.query.isNullOrEmpty() || !uri.fragment.isNullOrEmpty()) {
            throw IOException("同步服务器地址不能带参数")
        }
        return Endpoint(host, port)
    }

    @Throws(IOException::class)
    fun get(
        endpoint: Endpoint,
        path: String,
        maxBytes: Long,
        label: String,
    ): ByteArray = withSocket(endpoint) { input, output ->
        sendRequest(output, path)
        val header = readResponseHeader(input, maxBytes, label)
        val body = readBody(input, header.bodyLength, maxBytes, label)
        verifyDigest(header.digest, body, label)
        if (header.status != STATUS_OK) {
            throw statusError(header.status, body, label)
        }
        body
    }

    @Throws(IOException::class)
    fun download(
        endpoint: Endpoint,
        path: String,
        destination: File,
        maxBytes: Long,
        label: String,
    ): Long = withSocket(endpoint) { input, output ->
        sendRequest(output, path)
        val header = readResponseHeader(input, maxBytes, label)

        if (header.status != STATUS_OK) {
            val body = readBody(
                input,
                header.bodyLength,
                minOf(maxBytes, MAX_ERROR_BYTES),
                label,
            )
            throw statusError(header.status, body, label)
        }

        val digest = MessageDigest.getInstance("SHA-256")
        var remaining = header.bodyLength
        val buffer = ByteArray(16 * 1024)
        FileOutputStream(destination).use { fileOut ->
            BufferedOutputStream(fileOut).use { out ->
                while (remaining > 0) {
                    val want = minOf(remaining, buffer.size.toLong()).toInt()
                    val read = input.read(buffer, 0, want)
                    if (read == -1) {
                        throw IOException("$label TCP 响应提前结束")
                    }
                    digest.update(buffer, 0, read)
                    out.write(buffer, 0, read)
                    remaining -= read
                }
                out.flush()
            }
        }
        if (!MessageDigest.isEqual(header.digest, digest.digest())) {
            throw IOException("$label TCP 响应校验失败")
        }
        header.bodyLength
    }

    private fun <T> withSocket(
        endpoint: Endpoint,
        block: (InputStream, OutputStream) -> T,
    ): T {
        val socket = Socket()
        try {
            socket.connect(
                InetSocketAddress(endpoint.host, endpoint.port),
                CONNECT_TIMEOUT_MS,
            )
            socket.soTimeout = READ_TIMEOUT_MS
            socket.tcpNoDelay = true
            val input = BufferedInputStream(socket.getInputStream())
            val output = BufferedOutputStream(socket.getOutputStream())
            return block(input, output)
        } finally {
            try {
                socket.close()
            } catch (_: IOException) {
                // The request result/exception is more useful than close().
            }
        }
    }

    @Throws(IOException::class)
    private fun sendRequest(output: OutputStream, path: String) {
        val pathBytes = path.toByteArray(StandardCharsets.UTF_8)
        if (pathBytes.size > MAX_PATH_BYTES) throw IOException("同步路径过长")

        val header = ByteBuffer.allocate(REQUEST_HEADER_SIZE)
            .order(ByteOrder.BIG_ENDIAN)
        header.put(REQUEST_MAGIC)
        header.put(PROTOCOL_VERSION.toByte())
        header.put(OP_GET.toByte())
        header.putInt(pathBytes.size)

        output.write(header.array())
        output.write(pathBytes)
        output.flush()
    }

    @Throws(IOException::class)
    private fun readResponseHeader(
        input: InputStream,
        maxBytes: Long,
        label: String,
    ): ResponseHeader {
        val header = readFully(input, RESPONSE_HEADER_SIZE, label)
        if (!header.copyOfRange(0, 4).contentEquals(RESPONSE_MAGIC)) {
            throw IOException("$label TCP 响应格式不正确")
        }
        if ((header[4].toInt() and 0xff) != PROTOCOL_VERSION) {
            throw IOException("$label TCP 协议版本不支持")
        }

        val status = header[5].toInt() and 0xff
        val bodyLength = ByteBuffer.wrap(header, 8, 8)
            .order(ByteOrder.BIG_ENDIAN)
            .long
        if (bodyLength < 0 || bodyLength > maxBytes) {
            throw IOException("$label 响应大小非法")
        }
        val digest = header.copyOfRange(16, 48)
        return ResponseHeader(status, bodyLength, digest)
    }

    @Throws(IOException::class)
    private fun readBody(
        input: InputStream,
        length: Long,
        maxBytes: Long,
        label: String,
    ): ByteArray {
        if (length < 0 || length > maxBytes || length > Int.MAX_VALUE) {
            throw IOException("$label 响应大小非法")
        }
        return readFully(input, length.toInt(), label)
    }

    @Throws(IOException::class)
    private fun readFully(
        input: InputStream,
        length: Int,
        label: String,
    ): ByteArray {
        val out = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val read = input.read(out, offset, length - offset)
            if (read == -1) {
                throw IOException("$label TCP 响应提前结束")
            }
            offset += read
        }
        return out
    }

    private fun verifyDigest(expected: ByteArray, body: ByteArray, label: String) {
        val actual = MessageDigest.getInstance("SHA-256").digest(body)
        if (!MessageDigest.isEqual(expected, actual)) {
            throw IOException("$label TCP 响应校验失败")
        }
    }

    private fun statusError(status: Int, body: ByteArray, label: String): IOException {
        val text = String(body, StandardCharsets.UTF_8).trim()
        val detail = if (text.isEmpty()) {
            ""
        } else {
            val message = try {
                JSONObject(text).optString("error").ifBlank { text }
            } catch (_: Exception) {
                text
            }
            "：" + shorten(message, 200)
        }
        return IOException("$label TCP ${statusName(status)}$detail")
    }

    private fun statusName(status: Int): String = when (status) {
        STATUS_BAD_REQUEST -> "请求错误"
        STATUS_NOT_FOUND -> "文件不存在"
        STATUS_TOO_LARGE -> "响应过大"
        STATUS_SERVER_ERROR -> "服务器错误"
        else -> "状态 $status"
    }

    private fun shorten(text: String, max: Int): String {
        val oneLine = text.replace('\n', ' ').trim()
        return if (oneLine.length <= max) oneLine else oneLine.substring(0, max) + "…"
    }
}
