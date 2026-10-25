package com.example.hybriddebug

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.DataInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.max
import kotlin.math.min

/**
 * Client for the custom bundle sync protocol, v3.
 *
 * This intentionally uses a raw Socket instead of HttpURLConnection. Android's
 * cleartext policy is enforced by the HTTP stack (and WebView), not by raw TCP,
 * so this path is not subject to `usesCleartextTraffic`/NetworkSecurityConfig.
 * It is still plaintext on the wire; SHA-256 checks provide integrity, not
 * confidentiality. Production deployments should put TLS or a VPN underneath.
 *
 * One [Session] keeps one TCP connection open for its whole life and carries
 * every GET/PUT/MESSAGE/EVENT/PING frame in both directions. Each request has a
 * requestId, so responses may arrive in any order and several requests may be
 * in flight at once.
 *
 * Wire format matches core/bundle-protocol.js:
 *
 *   "HBT1" | version | type | flags | reserved |
 *   requestId u32 | payloadLen u32 | payload
 *
 * Server frames use "HBR1". The server echoes MESSAGE, pushes subscribed
 * EVENT frames, and sends PING; the reader answers every PING with PONG.
 */
internal object BundleTcpClient {

    private const val PROTOCOL_VERSION = 3
    private const val FRAME_HEADER_SIZE = 16
    private const val RESPONSE_PREFIX_SIZE = 34
    private const val MAX_PAYLOAD_BYTES = 128L * 1024 * 1024
    private const val MAX_PATH_BYTES = 4096
    private const val MAX_UPLOAD_BYTES = 64L * 1024 * 1024
    private const val MAX_MESSAGE_BYTES = 1L * 1024 * 1024
    private const val MAX_CONTROL_BYTES = 64L * 1024
    private const val DEFAULT_PORT = 9090
    private const val CONNECT_TIMEOUT_MS = 8000
    private const val INITIAL_READ_TIMEOUT_MS = 60000
    private const val DEFAULT_TIMEOUT_MS = 30000L
    private const val DOWNLOAD_TIMEOUT_MS = 120000L

    private const val TYPE_HELLO = 1
    private const val TYPE_WELCOME = 2
    private const val TYPE_GET = 3
    private const val TYPE_RESPONSE = 4
    private const val TYPE_PUT = 5
    private const val TYPE_MESSAGE = 6
    private const val TYPE_EVENT = 7
    private const val TYPE_SUBSCRIBE = 8
    private const val TYPE_PING = 9
    private const val TYPE_PONG = 10
    private const val TYPE_ERROR = 11
    private const val TYPE_CLOSE = 12

    private const val STATUS_OK = 0
    private const val STATUS_BAD_REQUEST = 1
    private const val STATUS_NOT_FOUND = 2
    private const val STATUS_TOO_LARGE = 3
    private const val STATUS_SERVER_ERROR = 4

    private val REQUEST_MAGIC = "HBT1".toByteArray(StandardCharsets.US_ASCII)
    private val RESPONSE_MAGIC = "HBR1".toByteArray(StandardCharsets.US_ASCII)

    data class Endpoint(val host: String, val port: Int) {
        override fun toString(): String = "tcp://$host:$port"
    }

    data class Welcome(
        val server: String,
        val protocol: Int,
        val heartbeatMs: Long,
        val capabilities: List<String>,
    )

    interface Listener {
        /** Called on the session reader thread. */
        fun onEvent(name: String, data: JSONObject?)

        /** Called on the session reader thread when the connection ends. */
        fun onClosed(reason: String?)
    }

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

    /**
     * A full-duplex connection. Public methods are blocking and may be called
     * from several threads; the reader thread owns all incoming framing.
     */
    class Session(private val endpoint: Endpoint) : Closeable {

        private class Result(
            val type: Int,
            val payload: ByteArray? = null,
            val size: Long = 0,
            val error: IOException? = null,
        )

        private class Pending(
            val expectedType: Int,
            val label: String,
            val maxBytes: Long,
            val destination: File?,
        ) {
            val queue = ArrayBlockingQueue<Result>(1)
        }

        private val nextRequestId = AtomicInteger(1)
        private val pendingRequests = ConcurrentHashMap<Int, Pending>()
        private val writeLock = Any()

        @Volatile
        private var socket: Socket? = null

        @Volatile
        private var output: BufferedOutputStream? = null

        @Volatile
        private var readerThread: Thread? = null

        @Volatile
        private var closed = false

        @Volatile
        private var connected = false

        @Volatile
        private var heartbeatMs = 0L

        @Volatile
        private var welcomeInfo: Welcome? = null

        @Volatile
        var listener: Listener? = null

        val isConnected: Boolean
            get() = connected && !closed

        val welcome: Welcome?
            get() = welcomeInfo

        @Throws(IOException::class)
        fun connect(): Welcome {
            if (socket != null || connected || closed) {
                throw IOException("TCP 会话已经连接或已关闭")
            }

            val newSocket = Socket()
            try {
                newSocket.connect(
                    InetSocketAddress(endpoint.host, endpoint.port),
                    CONNECT_TIMEOUT_MS,
                )
                newSocket.soTimeout = INITIAL_READ_TIMEOUT_MS
                newSocket.tcpNoDelay = true
                socket = newSocket
                output = BufferedOutputStream(newSocket.getOutputStream())
            } catch (err: Exception) {
                try {
                    newSocket.close()
                } catch (_: IOException) {
                    // Preserve the connection error.
                }
                socket = null
                output = null
                closed = true
                throw if (err is IOException) err else IOException("TCP 连接失败", err)
            }

            val input = DataInputStream(BufferedInputStream(newSocket.getInputStream()))
            readerThread = Thread({ readLoop(input) }, "bundle-tcp-reader").apply {
                isDaemon = true
                start()
            }

            try {
                val hello = JSONObject()
                    .put("client", "hybrid-android")
                    .put("protocol", PROTOCOL_VERSION)
                    .put(
                        "capabilities",
                        JSONArray(
                            listOf(
                                "get",
                                "put",
                                "message",
                                "subscribe",
                                "event",
                                "heartbeat",
                            )
                        ),
                    )
                val result = request(
                    TYPE_HELLO,
                    hello.toString().toByteArray(StandardCharsets.UTF_8),
                    TYPE_WELCOME,
                    CONNECT_TIMEOUT_MS.toLong(),
                    "TCP 握手",
                    MAX_CONTROL_BYTES,
                )
                val payload = result.payload
                    ?: throw IOException("TCP 握手没有返回内容")
                val json = JSONObject(String(payload, StandardCharsets.UTF_8))
                val protocol = json.optInt("protocol", -1)
                if (protocol != PROTOCOL_VERSION) {
                    throw IOException("TCP 协议版本不支持：$protocol")
                }
                val info = Welcome(
                    server = json.optString("server", "bundle-server"),
                    protocol = protocol,
                    heartbeatMs = json.optLong("heartbeatMs", 15000L),
                    capabilities = readStringList(json.optJSONArray("capabilities")),
                )
                heartbeatMs = info.heartbeatMs
                welcomeInfo = info
                connected = true
                val readTimeout = max(heartbeatMs * 3, 45000L)
                    .coerceAtMost(Int.MAX_VALUE.toLong())
                    .toInt()
                socket?.soTimeout = readTimeout
                return info
            } catch (err: Exception) {
                val failure = if (err is IOException) {
                    err
                } else {
                    IOException("TCP 握手失败", err)
                }
                shutdown(failure, notify = false)
                throw failure
            }
        }

        @Throws(IOException::class)
        fun get(path: String, maxBytes: Long, label: String): ByteArray {
            val result = request(
                TYPE_GET,
                checkedPath(path),
                TYPE_RESPONSE,
                DEFAULT_TIMEOUT_MS,
                label,
                maxBytes,
            )
            return result.payload ?: throw IOException("$label TCP 响应没有内容")
        }

        /**
         * Streams a GET response body directly to [destination] and verifies
         * its checksum while writing. The destination is deleted on failure.
         */
        @Throws(IOException::class)
        fun download(
            path: String,
            destination: File,
            maxBytes: Long,
            label: String,
        ): Long {
            val result = request(
                TYPE_GET,
                checkedPath(path),
                TYPE_RESPONSE,
                DOWNLOAD_TIMEOUT_MS,
                label,
                maxBytes,
                destination,
            )
            return result.size
        }

        @Throws(IOException::class)
        fun put(path: String, body: ByteArray): JSONObject {
            val result = request(
                TYPE_PUT,
                encodePutPayload(path, body),
                TYPE_RESPONSE,
                DEFAULT_TIMEOUT_MS,
                "上传",
                MAX_CONTROL_BYTES,
            )
            return parseJson(result.payload, "上传")
        }

        @Throws(IOException::class)
        fun message(body: ByteArray): ByteArray {
            if (body.size > MAX_MESSAGE_BYTES) throw IOException("消息过大")
            val result = request(
                TYPE_MESSAGE,
                body,
                TYPE_MESSAGE,
                DEFAULT_TIMEOUT_MS,
                "消息",
                MAX_MESSAGE_BYTES,
            )
            return result.payload ?: throw IOException("消息没有返回内容")
        }

        @Throws(IOException::class)
        fun subscribe(events: List<String>): JSONObject {
            val payload = JSONObject()
                .put("events", JSONArray(events))
                .toString()
                .toByteArray(StandardCharsets.UTF_8)
            val result = request(
                TYPE_SUBSCRIBE,
                payload,
                TYPE_RESPONSE,
                DEFAULT_TIMEOUT_MS,
                "订阅",
                MAX_CONTROL_BYTES,
            )
            return parseJson(result.payload, "订阅")
        }

        @Throws(IOException::class)
        fun ping(): Long {
            val payload = ByteBuffer.allocate(8)
                .order(ByteOrder.BIG_ENDIAN)
                .putLong(System.currentTimeMillis())
                .array()
            val started = System.nanoTime()
            val result = request(
                TYPE_PING,
                payload,
                TYPE_PONG,
                DEFAULT_TIMEOUT_MS,
                "心跳",
                MAX_CONTROL_BYTES,
            )
            if (result.payload == null || !result.payload.contentEquals(payload)) {
                throw IOException("PONG 没有回显 PING")
            }
            return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        }

        override fun close() {
            if (closed) return
            try {
                sendFrame(TYPE_CLOSE, 0, ByteArray(0))
            } catch (_: IOException) {
                // The socket may already be gone; shutdown still cleans up.
            }
            shutdown(IOException("会话已关闭"), notify = false)
        }

        @Throws(IOException::class)
        private fun request(
            type: Int,
            payload: ByteArray,
            expectedType: Int,
            timeoutMs: Long,
            label: String,
            maxBytes: Long,
            destination: File? = null,
        ): Result {
            ensureOpen()
            val requestId = nextId()
            val pending = Pending(expectedType, label, maxBytes, destination)
            pendingRequests[requestId] = pending
            try {
                sendFrame(type, requestId, payload)
            } catch (err: IOException) {
                pendingRequests.remove(requestId)
                throw err
            }

            val result = try {
                pending.queue.poll(timeoutMs, TimeUnit.MILLISECONDS)
            } catch (err: InterruptedException) {
                Thread.currentThread().interrupt()
                pendingRequests.remove(requestId)
                throw IOException("$label 已取消", err)
            }
            if (result == null) {
                pendingRequests.remove(requestId)
                throw IOException("$label 超时")
            }
            result.error?.let { throw it }
            if (result.type != expectedType) {
                throw IOException("$label 收到意外的帧类型 ${result.type}")
            }
            return result
        }

        private fun ensureOpen() {
            if (closed) throw IOException("TCP 会话已关闭")
            if (socket == null || output == null) throw IOException("TCP 会话未连接")
        }

        private fun nextId(): Int {
            synchronized(nextRequestId) {
                while (true) {
                    val id = nextRequestId.get()
                    val next = if (id >= Int.MAX_VALUE) 1 else id + 1
                    nextRequestId.set(next)
                    if (!pendingRequests.containsKey(id)) return id
                }
            }
        }

        @Throws(IOException::class)
        private fun sendFrame(type: Int, requestId: Int, payload: ByteArray) {
            if (payload.size > MAX_PAYLOAD_BYTES) {
                throw IOException("发送帧过大")
            }
            val header = ByteBuffer.allocate(FRAME_HEADER_SIZE)
                .order(ByteOrder.BIG_ENDIAN)
                .put(REQUEST_MAGIC)
                .put(PROTOCOL_VERSION.toByte())
                .put(type.toByte())
                .put(0)
                .put(0)
                .putInt(requestId)
                .putInt(payload.size)
                .array()

            synchronized(writeLock) {
                val out = output ?: throw IOException("TCP 会话未连接")
                out.write(header)
                if (payload.isNotEmpty()) out.write(payload)
                out.flush()
            }
        }

        /**
         * Reads frames until the socket fails or the peer closes. Any socket
         * timeout means the server heartbeat stopped, so the session is dead.
         */
        private fun readLoop(input: DataInputStream) {
            var reason: IOException? = null
            try {
                while (!closed) {
                    val header = ByteArray(FRAME_HEADER_SIZE)
                    input.readFully(header)
                    if (!header.copyOfRange(0, 4).contentEquals(RESPONSE_MAGIC)) {
                        throw IOException("TCP 响应格式不正确")
                    }
                    if ((header[4].toInt() and 0xff) != PROTOCOL_VERSION) {
                        throw IOException("TCP 协议版本不支持")
                    }
                    if ((header[6].toInt() and 0xff) != 0 ||
                        (header[7].toInt() and 0xff) != 0
                    ) {
                        throw IOException("TCP 帧标志不支持")
                    }

                    val type = header[5].toInt() and 0xff
                    if (type !in TYPE_HELLO..TYPE_CLOSE) {
                        throw IOException("TCP 帧类型不支持：$type")
                    }
                    val requestId = ByteBuffer.wrap(header, 8, 4)
                        .order(ByteOrder.BIG_ENDIAN)
                        .int
                    val payloadLength = ByteBuffer.wrap(header, 12, 4)
                        .order(ByteOrder.BIG_ENDIAN)
                        .int
                        .toLong() and 0xffffffffL
                    if (payloadLength > MAX_PAYLOAD_BYTES) {
                        throw IOException("TCP 帧过大")
                    }
                    handleFrame(input, type, requestId, payloadLength)
                }
            } catch (_: SocketTimeoutException) {
                reason = IOException("TCP 心跳超时")
            } catch (_: InterruptedIOException) {
                reason = IOException("TCP 读取中断")
            } catch (err: IOException) {
                if (!closed) reason = err
            } catch (err: Exception) {
                if (!closed) reason = IOException("TCP 读取失败", err)
            } finally {
                shutdown(reason, notify = reason != null)
            }
        }

        @Throws(IOException::class)
        private fun handleFrame(
            input: DataInputStream,
            type: Int,
            requestId: Int,
            payloadLength: Long,
        ) {
            when (type) {
                TYPE_RESPONSE -> handleResponse(input, requestId, payloadLength)

                TYPE_PING -> {
                    val payload = readPayload(input, payloadLength, MAX_CONTROL_BYTES)
                    sendFrame(TYPE_PONG, requestId, payload)
                }

                TYPE_PONG -> {
                    val payload = readPayload(input, payloadLength, MAX_CONTROL_BYTES)
                    complete(requestId, Result(TYPE_PONG, payload))
                }

                TYPE_WELCOME,
                TYPE_MESSAGE -> {
                    val limit = if (type == TYPE_MESSAGE) {
                        MAX_MESSAGE_BYTES
                    } else {
                        MAX_CONTROL_BYTES
                    }
                    val payload = readPayload(input, payloadLength, limit)
                    complete(requestId, Result(type, payload))
                }

                TYPE_EVENT -> {
                    val payload = readPayload(input, payloadLength, MAX_CONTROL_BYTES)
                    val json = JSONObject(String(payload, StandardCharsets.UTF_8))
                    val name = json.optString("event")
                    val data = json.optJSONObject("data")
                    try {
                        listener?.onEvent(name, data)
                    } catch (_: Exception) {
                        // A listener must not take down the reader thread.
                    }
                }

                TYPE_ERROR -> {
                    val payload = readPayload(input, payloadLength, MAX_CONTROL_BYTES)
                    val error = protocolError(payload)
                    if (!complete(requestId, Result(TYPE_ERROR, error = error))) {
                        try {
                            listener?.onEvent(
                                "error",
                                JSONObject(String(payload, StandardCharsets.UTF_8)),
                            )
                        } catch (_: Exception) {
                            // Ignore malformed or listener errors.
                        }
                    }
                }

                TYPE_CLOSE -> {
                    skipFully(input, payloadLength)
                    throw IOException("服务器关闭了会话")
                }

                else -> throw IOException("TCP 帧类型不支持：$type")
            }
        }

        @Throws(IOException::class)
        private fun handleResponse(
            input: DataInputStream,
            requestId: Int,
            payloadLength: Long,
        ) {
            if (payloadLength < RESPONSE_PREFIX_SIZE) {
                throw IOException("TCP 响应头不完整")
            }
            val prefix = ByteArray(RESPONSE_PREFIX_SIZE)
            input.readFully(prefix)
            val status = prefix[0].toInt() and 0xff
            val digest = prefix.copyOfRange(2, RESPONSE_PREFIX_SIZE)
            val bodyLength = payloadLength - RESPONSE_PREFIX_SIZE
            val pending = pendingRequests[requestId]

            if (pending == null) {
                skipFully(input, bodyLength)
                return
            }

            val cap = if (status == STATUS_OK) {
                pending.maxBytes
            } else {
                min(pending.maxBytes, MAX_CONTROL_BYTES)
            }
            if (bodyLength > cap || bodyLength > Int.MAX_VALUE) {
                skipFully(input, bodyLength)
                complete(
                    requestId,
                    Result(
                        TYPE_RESPONSE,
                        error = IOException("${pending.label} 响应过大"),
                    ),
                )
                return
            }

            if (status == STATUS_OK && pending.destination != null) {
                try {
                    streamBody(input, bodyLength, digest, pending.destination)
                } catch (err: IOException) {
                    pending.destination.delete()
                    throw err
                }
                complete(requestId, Result(TYPE_RESPONSE, size = bodyLength))
                return
            }

            val body = ByteArray(bodyLength.toInt())
            input.readFully(body)
            verifyDigest(digest, body, pending.label)
            if (status != STATUS_OK) {
                complete(
                    requestId,
                    Result(TYPE_RESPONSE, error = statusError(status, body, pending.label)),
                )
                return
            }
            complete(requestId, Result(TYPE_RESPONSE, payload = body))
        }

        @Throws(IOException::class)
        private fun streamBody(
            input: DataInputStream,
            length: Long,
            digest: ByteArray,
            destination: File,
        ) {
            destination.parentFile?.let { parent ->
                if (!parent.isDirectory && !parent.mkdirs()) {
                    throw IOException("无法创建下载目录")
                }
            }
            val sha = MessageDigest.getInstance("SHA-256")
            var remaining = length
            val buffer = ByteArray(16 * 1024)
            FileOutputStream(destination).use { fileOut ->
                BufferedOutputStream(fileOut).use { out ->
                    while (remaining > 0) {
                        val want = min(remaining, buffer.size.toLong()).toInt()
                        val read = input.read(buffer, 0, want)
                        if (read == -1) throw IOException("TCP 响应提前结束")
                        sha.update(buffer, 0, read)
                        out.write(buffer, 0, read)
                        remaining -= read
                    }
                    out.flush()
                }
            }
            if (!MessageDigest.isEqual(digest, sha.digest())) {
                throw IOException("TCP 响应校验失败")
            }
        }

        @Throws(IOException::class)
        private fun readPayload(
            input: DataInputStream,
            length: Long,
            limit: Long,
        ): ByteArray {
            if (length < 0 || length > limit || length > Int.MAX_VALUE) {
                throw IOException("TCP 帧大小非法")
            }
            return ByteArray(length.toInt()).also { input.readFully(it) }
        }

        @Throws(IOException::class)
        private fun skipFully(input: DataInputStream, length: Long) {
            var remaining = length
            val buffer = ByteArray(8 * 1024)
            while (remaining > 0) {
                val want = min(remaining, buffer.size.toLong()).toInt()
                val read = input.read(buffer, 0, want)
                if (read == -1) throw IOException("TCP 响应提前结束")
                remaining -= read
            }
        }

        private fun complete(requestId: Int, result: Result): Boolean {
            val pending = pendingRequests.remove(requestId) ?: return false
            pending.queue.offer(result)
            return true
        }

        private fun shutdown(error: IOException?, notify: Boolean) {
            if (closed) return
            closed = true
            connected = false
            welcomeInfo = null
            val current = socket
            socket = null
            output = null
            if (current != null) {
                try {
                    current.close()
                } catch (_: IOException) {
                    // Preserve the original cause.
                }
            }
            val failure = error ?: IOException("TCP 会话已关闭")
            val entries = ArrayList(pendingRequests.values)
            pendingRequests.clear()
            for (pending in entries) {
                pending.queue.offer(Result(TYPE_ERROR, error = failure))
            }
            if (notify) {
                try {
                    listener?.onClosed(failure.message)
                } catch (_: Exception) {
                    // Listener callbacks are best effort.
                }
            }
        }

        @Throws(IOException::class)
        private fun checkedPath(path: String): ByteArray {
            if (path.isEmpty() || !path.startsWith("/")) {
                throw IOException("同步路径必须以 / 开头")
            }
            val bytes = path.toByteArray(StandardCharsets.UTF_8)
            if (bytes.size > MAX_PATH_BYTES) throw IOException("同步路径过长")
            if (path.contains('\u0000')) throw IOException("同步路径非法")
            return bytes
        }

        @Throws(IOException::class)
        private fun encodePutPayload(path: String, body: ByteArray): ByteArray {
            if (body.size > MAX_UPLOAD_BYTES) throw IOException("上传内容过大")
            val pathBytes = checkedPath(path)
            val payload = ByteBuffer.allocate(2 + pathBytes.size + 32 + body.size)
                .order(ByteOrder.BIG_ENDIAN)
                .putShort(pathBytes.size.toShort())
                .put(pathBytes)
                .put(MessageDigest.getInstance("SHA-256").digest(body))
                .put(body)
                .array()
            return payload
        }

        @Throws(IOException::class)
        private fun verifyDigest(expected: ByteArray, body: ByteArray, label: String) {
            val actual = MessageDigest.getInstance("SHA-256").digest(body)
            if (!MessageDigest.isEqual(expected, actual)) {
                throw IOException("$label TCP 响应校验失败")
            }
        }

        @Throws(IOException::class)
        private fun parseJson(payload: ByteArray?, label: String): JSONObject {
            if (payload == null) throw IOException("$label 没有返回内容")
            return try {
                JSONObject(String(payload, StandardCharsets.UTF_8))
            } catch (err: Exception) {
                throw IOException("$label 返回了非法 JSON", err)
            }
        }

        private fun protocolError(payload: ByteArray): IOException {
            val text = String(payload, StandardCharsets.UTF_8).trim()
            val message = try {
                JSONObject(text).optString("error").ifBlank { "服务器协议错误" }
            } catch (_: Exception) {
                "服务器协议错误"
            }
            return IOException(message)
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

        private fun readStringList(array: JSONArray?): List<String> {
            if (array == null) return emptyList()
            val out = ArrayList<String>(array.length())
            for (i in 0 until array.length()) {
                val value = array.optString(i)
                if (value.isNotEmpty()) out.add(value)
            }
            return out
        }

        private fun shorten(text: String, max: Int): String {
            val oneLine = text.replace('\n', ' ').trim()
            return if (oneLine.length <= max) oneLine else oneLine.substring(0, max) + "…"
        }
    }
}
