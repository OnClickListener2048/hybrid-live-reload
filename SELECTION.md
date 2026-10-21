# 手机 Hybrid App 本地联调工具选型方案

> 版本：v0.4（工具形态 + 构建工具无关）  
> 日期：2026-10-20  
> **App 运行平台：Android、iOS**  
> **工具运行平台：Windows、macOS**  
> Web：Vue3 + 构建工具待定（Vite / Webpack / Rspack / 其他）  
> 生产 Web：远程 URL  
> SSO：手机端 WebView

---

## 0. 结论（TL;DR）

1. **App 只覆盖 Android / iOS**；Windows / macOS 不是 App 平台，而是**开发者机器**，工具必须能在这两个系统上跑。
2. **主方案：Whistle 同源代理**。手机 App 继续加载生产域名 `https://app.example.com`，Whistle 在开发机上把 HTML/JS 映射到本地 dev server（Vite / Webpack / Rspack / 任意 HTTP 服务，命令可配），API / SSO 透传。页面 origin 不变，SSO 不用部署，同时获得 HMR。
3. **直连模式（可选）**：Android 用 `adb reverse` / 局域网；iOS 模拟器用 `localhost`，真机用局域网。只适合非 SSO 页面。
4. **预览模式（可选）**：Whistle 映射到 `vite preview` / `dist`，验证真实构建产物。
5. **Android 原生拦截（可选）**：`shouldInterceptRequest` 可以去掉代理；iOS WKWebView 没有 https 响应体拦截 API，**只能走 Whistle**。
6. **工具形态：Node/TS 核心 daemon + Web 控制台，VSCode 插件作为首发壳，桌面应用后置**。核心只依赖“启动本地 dev server 的命令 + URL”，不绑定 Vite；同一套核心同时支持 Windows 和 macOS。iOS 的构建、安装、模拟器、Safari 调试**依赖 Xcode，只能在 macOS 上做**。
7. **核心 MVP 约 2–3 人天**（macOS 上跑通 Android + iOS）；VSCode 插件壳 +1–2 人天；Windows 上验证 Android 再加 0.5 人天；桌面壳（可选）+2–3 人天。

> 硬约束：**Windows 版工具不能构建/安装/调试 iOS**。如果团队有 Windows 开发者需要调 iOS，必须配 Mac、远程 Mac 或 CI。

---

## 1. 范围修正（最重要）

之前的方案把 Windows/macOS 当成了 App 平台，这是错的。修正后：

| 项 | 结论 |
|---|---|
| App 运行平台 | Android、iOS |
| 工具运行平台 | Windows、macOS |
| 不在范围 | Windows/macOS 桌面 App、Electron、Tauri、WebView2、桌面 WKWebView |
| iOS 硬约束 | 构建、安装、真机/模拟器调试依赖 Xcode，只能在 macOS 上做 |
| Windows 工具能力 | Android 全流程；iOS 只能给"已安装的 App"提供代理内容，不能构建/安装/检查 |
| 手机端 WebView | Android Chromium WebView、iOS WKWebView |
| 同源方案 | Whistle 对两个手机平台都适用；Android 可额外用原生拦截 |

由此带来的设计原则：

- 工具用 **Node.js** 写，不用 bash / PowerShell 脚本，避免 Windows/macOS 两套实现。
- 核心**不绑定构建工具**：只要求“能启动一个本地 HTTP dev server”，Vite / Webpack / Rspack / Angular CLI / Next.js / 静态服务器都按同一模型接入。
- 平台差异用 `process.platform` 隔离：`adb` 两端都有；`xcrun` / `simctl` / Safari 相关只在 macOS 启用。
- 代理和证书装在哪：**Whistle 跑在开发机，CA 装在手机**；开发机自身的系统信任库只在"用桌面浏览器验证"时才需要。
- 不要把桌面 WebView 的适配器写进工具，避免范围膨胀。

---

## 1.5 原理：地址不变，内容本地化

一句话：**WebView 请求的 URL 始终是生产域名，只把响应内容换成本地。**

### 1.5.1 origin 由什么决定

- origin = scheme + host + port。
- Cookie、localStorage、OAuth 的 `redirect_uri`、WebAuthn 的 RP ID 都绑定 origin。
- origin 由 WebView 请求的 URL 决定，**不由响应来自哪台机器决定**。

所以：只要 URL 不变，origin 就不变；内容从哪来，浏览器并不关心。

### 1.5.2 一次请求的三层

| 层 | 例子 | 能不能动 |
|---|---|---|
| 导航层 | WebView 请求 `https://app.example.com/app.js` | **不能动**；改成 localhost 就换 origin |
| 网络层 | DNS / TCP / TLS 连到哪台机器 | 可以动（代理） |
| 响应层 | 返回什么字节 | 可以动（代理或拦截） |

结论：**动网络层和响应层，不动导航层。**

### 1.5.3 两种实现

**A. 代理（Whistle）**

```
WebView: GET https://app.example.com/app.js
   │ 手机 Wi-Fi 代理
   ▼
Whistle（开发机）
   ├─ 出示 app.example.com 证书（Whistle CA 签发）
   ├─ 静态资源 → 127.0.0.1:5173 (dev server)
   └─ /api /oauth → 真实服务器
   ▼
WebView 渲染；location.origin 仍是 https://app.example.com
```

- 手机信任 Whistle CA → TLS 通过。
- 不是 302，不是跳转，是透明替换。
- Android / iOS 都适用；iOS 唯一可行。

**B. WebView 拦截（仅 Android）**

- WebView 请求生产 URL。
- `shouldInterceptRequest` 返回本地字节。
- URL 不变，origin 不变。
- 限制：GET only、无 WebSocket、iOS 无此 API。

### 1.5.4 为什么 SSO 就通了

1. 前端看到 `location.origin = https://app.example.com`。
2. 跳 IdP，IdP 回调 `https://app.example.com/callback`。
3. 代理/拦截把 callback 页面从本地返回（如果回调由后端处理，则透传真实服务器）。
4. 后端 `Set-Cookie` 到 `app.example.com`，WebView 正常保存。
5. `/oauth/token` 透传真实服务器。
6. `redirect_uri` 匹配、Cookie 带上、localStorage 保留、WebAuthn RP ID 匹配。

整个过程不需要把本地页面部署到服务器。

### 1.5.5 为什么推包 / 本地 server 不行

- WebView 地址变成 `file://` 或 `http://127.0.0.1:port` → origin 变了。
- Cookie 不带、`redirect_uri` 不匹配、WebAuthn 失败。
- 内容一样也没用，SSO 认的是地址。
- 本地 HTTPS + 改 hosts 理论上能保 origin，但手机改 DNS/hosts 要 root，不现实。
- `loadDataWithBaseURL` 只能伪造初始 HTML 的 base URL，撑不起 SPA。

### 1.5.6 前提与边界

- 手机信任 Whistle CA。
- App 没有证书固定（pinning）。
- App 的 WebView 使用系统代理（默认）。
- Android 需要 debug 包信任用户 CA；iOS 安装描述文件并完全信任。
- HMR 的 WebSocket 需要代理正确转发；不通则退化为文件监听 + reload。
- release 包不包含 dev 入口、不信任用户 CA、不放行明文。

---

## 2. 背景与问题

当前 Web 改动要在手机 App 里看到效果，需要：

```
修改 Web 代码
  → npm run build
  → 拷贝 dist 到 native 工程 assets/www
  → 重新编译 Android / iOS
  → 安装、启动
```

一次改动 5–15 分钟；SSO 相关改动还要部署服务器。按每天 20 次页面调整估算，**每天浪费 1.5–4 小时**。

SSO 的根因不是"网络通不通"，而是 **origin 变了**：

- OAuth2 / OIDC 的 `redirect_uri` 在 IdP 有白名单，只认生产域名。
- 会话 Cookie 种在业务域名下，换 `localhost` 就不带。
- `SameSite`、第三方 Cookie、`localStorage`、Service Worker 都按 origin 隔离。
- WebAuthn / Passkey 的 RP ID 直接绑定域名，`localhost` 必然失败。
- 部分前端代码会校验 `location.origin`。

所以"让 WebView 加载 `http://localhost:5173`"只能解决普通页面，解决不了 SSO。**必须让页面继续以生产域名运行，只把内容换成本地。**

---

## 3. 目标与非目标

### 3.1 目标

- Web 代码改动后，Android / iOS App **≤3 秒**看到效果，不再重新打 native 包。
- SSO 全流程（跳转、回调、换 token、写 Cookie）在手机本地可走通，**不需要部署**。
- 工具在 **Windows 和 macOS** 开发机上都能运行；Windows 覆盖 Android，macOS 覆盖 Android + iOS。
- 工具可复用到其他外包项目。
- 对 release 包零影响，调试能力不能泄漏到生产。

### 3.2 非目标

- 不做 Windows/macOS 桌面 App。
- 不做面向线上用户的 OTA 热更新。
- 不替换现有 CI、签名、发布流程。
- 不为了调试能力迁移壳框架。
- 不解决 native UI 的热重载。

---

## 4. 已确认与待确认

### 4.1 已确认

- App 壳：**原生 Android / iOS**。
- App 平台：**Android、iOS**。
- 工具宿主：**Windows、macOS**。
- 生产环境 Web：**有远程地址**，App 通过 URL 加载。
- SSO：在手机端 WebView 内完成，需要本地联调。
- Web：Vue3；构建工具不固定（Vite / Webpack / Rspack 等），工具按“命令 + URL”适配。
- 不在范围：桌面 App。

### 4.2 待确认（不阻塞 P1）

| 待确认项 | 为什么重要 | 影响 |
|---|---|---|
| 是否还有本地 assets 离线包 | 决定是否需要 assets 模式 | 中 |
| SSO 清单：协议、IdP、`redirect_uri`、Cookie 域 | 决定哪些流程必须同源 | 高 |
| 是否有证书固定（pinning） | 决定 Whistle 是否可行 | 高 |
| 是否有 WebAuthn / Passkey / mTLS | 必须同源或需要特殊处理 | 高 |
| Android 测试包能否出 debug 构建 | 决定用户 CA 是否被信任 | 高 |
| Windows 开发者是否需要调 iOS | Windows 无法构建/调试 iOS | 高 |
| 测试设备能否改 Wi-Fi 代理、装 CA | 决定同源模式能否落地 | 中 |
| 公司网络是否 AP 隔离 / 防火墙限制 | 决定手机能否访问开发机 | 中 |

---

## 5. 业界成熟方案调研

### 5.1 Capacitor Live Reload（移动端最值得借鉴）

Capacitor 在 `capacitor.config.ts` 提供：

```ts
server: {
  url: 'http://192.168.1.10:5173',
  cleartext: true,
  androidScheme: 'https',
}
```

`npx cap run android -l --external` 自动把 dev server 注入壳，WebView 直接加载，HMR 生效。

**可借鉴**：Web 入口做成可配置 URL；调试入口是框架级能力，不是外挂脚本。  
**局限**：只覆盖移动端；迁移现有原生壳成本高。

### 5.2 Cordova `--lr`

同样是 WebView 指向 dev server，思路与 Capacitor 一致。

### 5.3 React Native Dev Menu / Metro

调试入口 UX 参考：摇一摇打开菜单、输入/扫描 bundle 地址、Reload、错误浮层。

### 5.4 Whistle（同源场景核心）

腾讯开源的 HTTP/HTTPS 代理，支持规则匹配、Map Local、反向代理、WebSocket、HTTPS 中间人。

典型规则：

```
app.example.com/api/     direct://
app.example.com/oauth/   direct://
app.example.com/         proxy://127.0.0.1:5173
```

浏览器/WebView 认为自己在访问 `app.example.com`，但静态资源来自本地 dev server，API / SSO 打到真实服务器。**origin 完全不变。**

**为什么 origin 不变**：origin 由浏览器请求的 URL 决定，不由响应来自哪台机器决定。Whistle 是透明代理，不是 302 重定向。

**前提**：手机信任 Whistle CA；App 没有证书固定；手机能访问开发机的代理端口。

### 5.5 AndroidX WebViewAssetLoader

把 `assets/` 通过 `https://appassets.androidplatform.net/` 提供给 WebView，解决 `file://` 的 origin / CORS 问题。

**适用**：生产环境是本地离线包，且希望本地包有正常 https origin。  
**不适用**：本地开发热更新（更新 assets 仍要重新打包）。

### 5.6 Android `shouldInterceptRequest`

WebView 加载生产 URL，对 GET 请求返回本地内容：

```kotlin
override fun shouldInterceptRequest(
    view: WebView,
    req: WebResourceRequest
): WebResourceResponse? {
    if (!BuildConfig.DEBUG || req.method != "GET") return null
    if (!isStaticAsset(req.url)) return null
    val local = fetchFromDevServer(req.url) // GET http://127.0.0.1:5173
    return WebResourceResponse(local.mime, "UTF-8", local.stream)
}
```

- URL 不变 → origin 不变；**不要返回 302 到 localhost**。
- 限制：只能拦 GET；WebSocket 不走这个回调；iOS 无对应能力。

### 5.7 iOS WKWebView 的限制

WKWebView **没有** https 响应体拦截 API：

- `WKNavigationDelegate` 可以决定是否放行，但不能替换响应体。
- `WKURLSchemeHandler` 只支持自定义 scheme，会改 origin。
- 因此 iOS 的同源方案**只能靠代理**（Whistle / Charles / mitmproxy）。

### 5.8 远程调试

| 平台 | 工具 | 前置条件 |
|---|---|---|
| Android WebView | `chrome://inspect` | `WebView.setWebContentsDebuggingEnabled(true)` |
| iOS WKWebView | Safari → 开发 → 设备 | 设备开启 Web Inspector；iOS 16.4+ 需 `isInspectable = true` |

**Windows 可用 Chrome 调试 Android；Safari 调试 iOS 只能在 macOS。**

### 5.9 小结

| 能力 | 采用 |
|---|---|
| 壳可配置 Web 入口 | ✅ |
| 调试入口 UX（RN dev menu） | ✅ |
| 同源映射（Whistle） | ✅ 核心 |
| Android 原生拦截 | ✅ 可选 |
| iOS 原生拦截 | ❌ 不可行 |
| 远程调试 | ✅ 必做 |
| dev server HMR | ✅ |

---

## 6. 方案对比

| 方案 | Android | iOS | SSO 同源 | HMR | App 改动 | 成本 | 结论 |
|---|---|---|---|---|---|---|---|
| O1 直连 dev server | ✅ | ✅ | ❌ | ✅ | 中（一次） | 低 | 非 SSO 页面 |
| O2 Whistle 同源代理 | ✅ | ✅ | ✅ | ✅（需验证） | **无（远程 URL 场景）** | 低 | **主方案** |
| O3 Android 原生拦截 | ✅ | ❌ | ✅ | ⚠️ | 高 | 中 | 可选优化 |
| O4 本地 dist + 代理预览 | ✅ | ✅ | ✅ | ❌ | 无 / 低 | 低 | 构建产物验证 |
| O5 迁移 Capacitor | ✅ | ✅ | ✅ | ✅ | 极高 | 极高 | 不建议 |

**结论**：O2 为主；O1 作为"不想开代理"的补充；O4 用于发版前验证；O3 只在 Android 上做去代理优化；O5 不考虑。

---

## 7. 推荐架构

### 7.1 总体结构

```
┌──────────────────────────────────────┐
│ 开发机（Windows / macOS）              │
│  • Web dev server :5173（任意构建）    │
│  • Whistle 代理 :8899                 │
│  • hybrid-dev daemon + CLI/插件        │
│  • Vue 控制台（浏览器 / VSCode Webview）│
│  • adb（两端）/ xcrun（仅 macOS）      │
└───────────────┬──────────────────────┘
                │ 手机 Wi-Fi 代理 / adb reverse
                │ 或局域网直连
┌───────────────▼──────────────────────┐
│ 手机（Android / iOS）                  │
│  • App 原生壳                          │
│  • WebView 加载 https://生产域名       │
└──────────────────────────────────────┘
```

### 7.2 四种运行模式

| 模式 | 手机 WebView 加载 | 内容来源 | 适用 | SSO |
|---|---|---|---|---|
| **S 同源（主）** | `https://app.example.com` | Whistle → 本地 dev server | 所有页面，含 SSO；日常默认 | ✅ |
| **D 直连（可选）** | `http://localhost:5173` / 局域网 | 本地 dev server | 不想开代理的 UI 调试 | ❌ |
| **P 预览（可选）** | `https://app.example.com` | Whistle → 预览服务 / `dist` | 验证构建产物 | ✅ |
| **N Android 拦截（可选）** | `https://app.example.com` | `shouldInterceptRequest` → 本地 dev server | 去代理优化 | ✅ |

日常建议：

- **默认 S**：代理开一次，所有页面（含 SSO）同一环境，不用来回切。
- 代理影响其他调试时，再切 **D**（需要原生 debug 入口）。
- 发版前用 **P** 验证真实构建。
- **N** 只在代理不稳定时做，且只覆盖 Android。

### 7.3 为什么 O2 优先

1. 生产 Web 本来就是远程 URL，O2 **零业务代码改动**，只需一次代理 + 证书配置。
2. iOS 没有 https 拦截 API，O2 是 iOS 唯一可行的同源方案。
3. SSO 是最高风险、最高价值的部分，先验证它。
4. O1 / O4 都能复用 O2 的 CLI、配置和规则，不存在重复建设。

### 7.4 内容投递方式：推包 vs 拉包 vs 同源代理

| 方式 | 谁主动 | 内容来源 | HMR | 页面 origin | SSO | 适用 |
|---|---|---|---|---|---|---|
| A 推包 | PC → 手机 | `dist` 推到设备 | ❌ | `file://` / `127.0.0.1` | ❌（除非同源拦截） | 构建产物验证、离线演示 |
| B1 拉 dev server | 手机 → PC | 本地 dev server | ✅ | `localhost` / 局域网 | ❌ | 非 SSO 页面 |
| B2 手机内置 server + 拉包 | 手机 → PC，再本地 serve | `dist` | ❌ | `127.0.0.1` | ❌ | OTA/离线缓存，不适合开发主链路 |
| C 同源代理 | 手机 → 生产域名（代理转发到 PC） | 本地 dev server / dist | ✅ | **生产域名** | ✅ | **SSO 开发首选** |

关键结论：

- **SSO 的约束不是"包怎么到手机"，而是"换完内容后 origin 变不变"。**
- A / B1 / B2 都会改变 origin，解决不了 SSO。
- C 不改变 origin，是唯一能"手机停在 SSO 页面、改完代码原地更新、还不掉登录态"的方式。
- B2（手机内置 server）本质是 OTA 架构，需要下载、解压、版本、回滚、签名，不应混进开发工具。

---

## 8. App 平台与工具宿主

### 8.1 App 平台能力矩阵

| App 平台 | WebView 引擎 | 直连本地 | 同源（保 SSO） | 远程调试 |
|---|---|---|---|---|
| Android | Chromium WebView | ✅ `adb reverse` / 局域网 + 明文放行 | ✅ Whistle；可选 `shouldInterceptRequest` | `chrome://inspect` |
| iOS | WKWebView | ✅ 模拟器 `localhost`；真机局域网 + ATS 例外 | ✅ **只能 Whistle** | Safari Web Inspector（16.4+ 需 `isInspectable`） |

### 8.2 工具宿主能力矩阵（重点）

| 能力 | Windows | macOS |
|---|---|---|
| Node CLI / 任意 dev server / Whistle | ✅ | ✅ |
| Android `adb` / `adb reverse` / `logcat` | ✅ | ✅ |
| Android 模拟器 | ✅ | ✅ |
| Chrome `chrome://inspect` 调 Android | ✅ | ✅ |
| 给已安装的 iOS App 提供 Whistle 内容 | ✅（但无法检查） | ✅ |
| iOS 构建 / 安装 / 真机部署 | ❌（需要 Xcode） | ✅ |
| iOS 模拟器 / `simctl` | ❌ | ✅ |
| Safari Web Inspector 调 iOS | ❌ | ✅ |
| 手机 CA 安装（通过浏览器/文件） | ✅ | ✅ |
| 局域网共享 / 热点 | ✅（Windows 移动热点） | ✅（Internet Sharing） |

**结论**：

- **Windows 工具 = Android 全流程 + 给 iOS 提供代理内容（有限）**。
- **macOS 工具 = Android + iOS 完整流程**。
- 如果 Windows 开发者需要构建/调试 iOS，必须用 Mac / 远程 Mac / CI，工具无法绕过 Xcode 限制。

### 8.3 Android 落地

**直连模式**

```bash
adb reverse tcp:5173 tcp:5173
adb shell am start -n com.example.app/.dev.DevWebViewActivity \
  --es dev_url http://localhost:5173
```

- `src/debug/AndroidManifest.xml` 放行明文（或只放行 `localhost` / `10.0.2.2`）。
- `WebView.setWebContentsDebuggingEnabled(true)`。
- 复用生产 `WebViewClient`、JSBridge、UA、CookieManager、权限回调。
- 模拟器也可用 `10.0.2.2` 访问宿主机。

**同源模式**

方式一（推荐，适合 AP 隔离 / 防火墙严格）：

```bash
# 手机的 127.0.0.1:8899 反向映射到开发机的 Whistle
adb reverse tcp:8899 tcp:8899
# 手机 Wi-Fi 代理设置为 127.0.0.1:8899
```

方式二（局域网）：

```
手机 Wi-Fi 代理 → <开发机 LAN IP>:8899
```

- 安装 Whistle CA（浏览器打开 `http://rootca.pro` 或从开发机下载）。
- debug 包信任用户 CA：

```xml
<network-security-config>
  <debug-overrides>
    <trust-anchors>
      <certificates src="user" />
      <certificates src="system" />
    </trust-anchors>
  </debug-overrides>
</network-security-config>
```

- Android 7.0+ 用户 CA 默认不被 App 信任，**release 包或不可调试包无法用用户 CA**；必须 debug 构建或 root 装系统 CA。
- 可选：`shouldInterceptRequest` 做本地优先，去掉代理。

### 8.4 iOS 落地

**直连模式**

- 模拟器：`http://localhost:5173`（仅 macOS）。
- 真机：`http://<开发机 LAN IP>:<port>`，dev server 需 `--host 0.0.0.0`（Vite / Webpack 均需显式开启）。
- debug `Info.plist` ATS 例外（仅 debug）：

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key>
  <true/>
</dict>
```

**同源模式**

- 手机 Wi-Fi 代理 → `<开发机 LAN IP>:8899`。
- Safari 安装 Whistle 描述文件 → 设置 → 通用 → 关于本机 → 证书信任设置 → 完全信任。
- WKWebView 没有 https 拦截，**只能靠代理**。
- iOS 16.4+ 在壳里设置 `isInspectable = true`，Safari 才能检查 App 内 WebView。
- 真机部署/运行依赖 macOS + Xcode；Windows 无法完成。

**网络不通时**

- 手机和开发机必须同一网段；公司 Wi-Fi 可能 AP 隔离。
- 用手机热点让开发机加入，或用开发机开热点让手机加入。
- iOS 没有 `adb reverse`，只能走局域网；Android 优先用 `adb reverse tcp:8899` 绕过网络限制。

### 8.5 壳侧"开发契约"

**输入（任选其一）**

- Android：`Intent` extra、deep link、SharedPreferences、调试菜单。
- iOS：URL Scheme、UserDefaults、调试菜单。
- 通用：扫描二维码得到 `myapp://dev?url=<encoded>`。

**能力**

```
load(url)          // 加载指定地址，复用生产 WebView 配置
reload()           // 刷新
clearCache()       // 清 WebView 缓存 / Cookie
openDevTools()     // 打开远程调试
setToken(token)    // 调试期注入登录态（可选）
```

**最低要求**：debug 构建下能把 Web 入口从 assets / 生产 URL 切到指定 URL。  
如果连这一点都做不到，就只能走纯 Whistle（要求 App 本身加载远程 URL）。

### 8.6 跨平台核心实现约束

- Node.js 18+ / TypeScript；不要用 bash / PowerShell 两套脚本。
- 核心以 **daemon** 形式提供本地 HTTP/WS API；CLI、VSCode 插件、桌面壳、Web 控制台都调用同一套 API，不在壳里重复实现代理/设备逻辑。
- 平台判断：`process.platform === 'win32' | 'darwin'`。
- 子进程统一用 `execa` + 参数数组，避免 shell 引号差异。
- Windows：
  - `adb.exe` 从 `ANDROID_HOME` 或 `%LOCALAPPDATA%\Android\Sdk\platform-tools` 查找。
  - 防火墙：首次运行 Node 时允许"专用网络"；必要时提示 `netsh advfirewall` 加规则。
  - 不支持 `xcrun` / `simctl` / Safari；相关命令直接给清晰报错。
- macOS：
  - `adb` 从 `~/Library/Android/sdk/platform-tools` 或 `ANDROID_HOME`。
  - `xcrun simctl` / `xcodebuild` 可用。
  - 防火墙：系统设置 → 网络 → 防火墙允许 Node 传入连接。
- 路径：统一用 `path.join`；不要拼接 `/`。
- 分发：核心/CLI 用 `npm i -g hybrid-dev` 或 `npx hybrid-dev`；VSCode 插件发 VSIX；桌面壳后置；需要单文件时再用 `pkg` / `bun build --compile`。

### 8.7 网络与端口

- 开发机打印 LAN IP：Node `os.networkInterfaces()`；Windows 可对照 `ipconfig`，macOS 对照 `ipconfig getifaddr en0`。
- 端口：dev server（Vite 默认 5173、Webpack 默认 8080）、Whistle 8899；冲突时自动递增并在二维码/日志显示实际端口。
- 手机连通性检查：CLI 提供一个 `http://<开发机>:<port>/__hybrid_dev__/ping`，手机浏览器打开能通再继续。
- Android 优先 `adb reverse tcp:8899`，把代理地址固定为 `127.0.0.1:8899`，完全绕开局域网/防火墙。
- iOS 只能局域网，必要时用热点。

---

## 9. SSO 专项设计

### 9.1 先盘点

按附录 A 把每个 SSO 入口列一遍：

- 协议：OAuth2 / OIDC / SAML / CAS / 自研。
- IdP：自建 / 企业微信 / 钉钉 / 飞书 / Azure AD / Keycloak / 其他。
- 回调地址、Cookie 域、是否在 WebView 内。
- 是否有证书固定、IP 白名单、MFA、WebAuthn、mTLS。

### 9.2 按类型处理

| SSO 类型 | 直连 localhost | 同源代理 | 处理方式 |
|---|---|---|---|
| OAuth2 / OIDC 网页授权 | ❌ | ✅ | 手机加载生产 URL；Whistle 把 `/callback` 映射到本地 dev server；token API 透传 |
| Cookie / 同域会话 | ❌ | ✅ | origin 不变，Cookie 自动带上；验证 SameSite / 第三方 Cookie |
| SAML / 表单 POST 回调 | ❌ | ✅ | POST 透传真实服务器；回调页可由本地提供 |
| 原生 SDK / custom scheme | ✅ | ✅ | 直连即可；壳拦截 `myapp://callback`，把 token 注入 WebView |
| WebAuthn / Passkey | ❌ | ✅ | RP ID 绑定域名，必须同源 |
| 短信/扫码登录 | ✅ | ✅ | 无域名依赖，直连即可 |

### 9.3 同源模式下的 OAuth2 链路

```
1. 手机 WebView 打开 https://app.example.com/
2. Whistle 把 HTML/JS 映射到本地 dev server（origin 仍是 app.example.com）
3. 前端跳转 https://idp.example.com/authorize?redirect_uri=https://app.example.com/callback
   → 真实 IdP，正常登录
4. IdP 302 回 https://app.example.com/callback?code=...
   → Whistle 把 /callback 映射到本地 dev server 的 SPA 路由
5. 前端用 code 调 https://app.example.com/oauth/token
   → Whistle 把 /oauth/ 放行到真实服务器
6. 服务器 Set-Cookie: session=...; Domain=app.example.com
   → WebView 认为就是 app.example.com，正常保存
7. 后续 API 请求带 Cookie，Whistle 透传
```

> 如果 OAuth 回调由**后端**处理（不是 SPA 路由），把 `/callback` 也放行到真实服务器；本地只接管静态页面。SSO 仍能通，只是回调逻辑不在本地。

整条链路里没有任何一步知道本地 dev server 的存在，所以 SSO 与生产行为一致。

### 9.4 兜底方案

1. **同源代理**（首选）。
2. **让 IdP 加 dev redirect_uri**（`http://localhost:5173/callback`）：只在能改 IdP 时可用，Cookie 域可能仍不匹配。
3. **Token 注入**：原生登录一次，debug 期通过 JSBridge 把 token 写进 WebView；适合纯 UI 开发，不适合验证 SSO 本身。
4. **Debug 包关闭证书固定**：有 pinning 时才能代理；仅 debug，需安全评审。
5. **Staging 部署 + 远程调试**：以上都不行时的退路。

### 9.5 证书信任（装在手机，不在开发机）

| 平台 | 安装方式 | 注意 |
|---|---|---|
| Android | 设置 → 安全 → 安装证书；或浏览器打开 `http://rootca.pro` | 7.0+ 用户 CA 默认不被 App 信任，需要 debug `network_security_config` |
| iOS | Safari 下载描述文件 → 设置安装 → 证书信任设置开启 | 模拟器/真机分开 |

> 开发机自身的系统信任库只有在"用桌面浏览器验证"时才需要；手机联调不需要。

### 9.6 SSO 测试矩阵

- Android 真机 × 每种 SSO。
- iOS 真机 × 每种 SSO（模拟器不能替代证书/回调验证）。
- 冷启动登录、token 过期重登、取消授权、回调失败。
- 弱网 / 代理断开 / 证书未信任的报错提示。

---

## 10. 工具设计（`hybrid-dev`）

### 10.0 形态：核心 + 控制台 + 薄壳

不是“桌面端 / VSCode 插件 / CLI 三选一”，而是分层，壳可以换：

| 层 | 内容 | 说明 |
|---|---|---|
| 核心 daemon | 启动 dev server、Whistle、设备管理、日志、配置 | 一套逻辑，Windows/macOS 通用 |
| 控制台 UI | Vue3 页面，daemon 在 `http://127.0.0.1:<port>` 提供 | 浏览器直接可用；也是 VSCode Webview / 桌面壳的页面 |
| 壳 A：VSCode 插件 | 命令面板、状态栏、设备树、Webview 嵌控制台 | **首发推荐** |
| 壳 B：桌面应用 | Tauri / Electron 包同一套控制台 | 后置，非 MVP |
| 壳 C：CLI | 无 UI，脚本化 / CI | 始终保留 |

取舍：

- **VSCode 插件**：开发成本最低，不用签名/公证，不挑安装包；开发者本来就在 VSCode 里。适合“团队统一用 VSCode”的情况。
- **桌面应用**：UX 最好、可托盘常驻，能给测试/产品用；代价是 Electron 的体积/内存，或 Tauri 的 Rust + 签名/公证/自动更新工程量。
- **纯 CLI**：最稳，但配代理、看设备、扫码这些交互不友好。
- **核心 + Web 控制台**：一套 UI 同时给浏览器、VSCode Webview、桌面壳用。先做插件，桌面壳随时能加，不返工。

建议路线：P2 做核心 daemon + CLI + 浏览器控制台；P2.5 做 VSCode 插件；桌面端等“有人不用 VSCode”或“要给测试/产品用”时再做。

### 10.1 命令

```bash
hybrid-dev doctor                  # 检查 Node、adb、xcrun、dev server、Whistle、LAN IP、端口
hybrid-dev dev --platform android --mode same-origin
hybrid-dev dev --platform ios --mode same-origin      # 仅 macOS
hybrid-dev dev --platform android --mode direct
hybrid-dev preview                 # 构建并映射 dist
hybrid-dev sso on|off              # 切换 Whistle 规则
hybrid-dev logs --platform android
hybrid-dev qr                      # 打印代理/证书/深链二维码
hybrid-dev ui                      # 启动 daemon + 控制台，浏览器打开
hybrid-dev clean                   # 清 WebView 缓存 / Cookie
```

### 10.2 配置文件

```ts
// hybrid-dev.config.ts
export default {
  web: {
    // 任意构建工具：只要求能启动一个本地 HTTP 服务
    devCommand: 'npm run dev',          // Vite / Webpack / Rspack / Angular CLI 都行
    devUrl: 'http://127.0.0.1:5173',    // 实际地址；端口冲突时以工具探测为准
    readyWhen: { port: 5173 },          // 或 { stdout: 'Local:' } / { http: '/__ready' }
    previewCommand: 'npm run build && npx serve dist',
    previewUrl: 'http://127.0.0.1:3000',
    basePath: '/',                      // 生产有子路径、本地没有时用
    hostRewrite: true,                  // dev server 校验 Host 时，改写成 127.0.0.1:<port>
  },
  origins: {
    prod: 'https://app.example.com',
    passthrough: ['/api', '/oauth', '/sso', '/login'],
  },
  whistle: {
    port: 8899,
    // 规则由工具按上面的配置生成；手写规则可放 rules 追加
    rules: [],
  },
  android: {
    packageName: 'com.example.app',
    devActivity: '.dev.DevWebViewActivity',
  },
  ios: {
    urlScheme: 'exampleapp',
    bundleId: 'com.example.app',
  },
};
```

### 10.3 组件拆分

| 模块 | 职责 |
|---|---|
| Daemon | 本地 HTTP/WS API；生命周期、编排、状态（端口、设备、代理） |
| CLI | 参数解析、调用 daemon、无 UI / CI 场景 |
| Control UI | Vue3 控制台：启停、设备、规则、日志、二维码 |
| VSCode Adapter | 命令面板、状态栏、设备树、Webview 嵌控制台 |
| Host Manager | Windows/macOS 判断、LAN IP、防火墙提示 |
| Device Manager | `adb`、`xcrun devicectl` / `simctl`、USB / Wi-Fi 设备发现 |
| Web Server Manager | 启动/复用任意 dev server，就绪探测，日志转发 |
| Proxy Manager | 启动 Whistle、按配置生成规则、开关 SSO 模式 |
| Launcher | Android intent / iOS scheme / simctl openurl |
| Log Streamer | `adb logcat`、`simctl log`、dev server / Whistle 日志 |
| QR / Deep Link | 生成代理配置 / CA 下载 / 深链二维码 |
| Doctor | 环境自检、端口、CA、连通性、Host 校验探测 |

### 10.4 宿主平台行为

| 命令 | Windows | macOS |
|---|---|---|
| `dev --platform android` | ✅ | ✅ |
| `dev --platform ios` | ❌ 报错并提示用 macOS | ✅ |
| `preview` | ✅（Android 验证） | ✅（Android + iOS） |
| `doctor` | 检查 adb、Node、端口、防火墙 | 检查 adb、xcrun、Node、端口、防火墙 |
| `logs --platform ios` | ❌ | ✅ `simctl log` |

### 10.5 启动流程

```
1. 读配置
2. doctor：宿主 OS、adb / xcrun、端口、Whistle、LAN IP
3. 启动或复用 web dev server（按 `web.devCommand`，Vite / Webpack / … 均可）
4. 按 mode：
   - same-origin: 启动 Whistle，下发规则，提示手机代理
   - direct: Android adb reverse；iOS 局域网
5. 拉起 App：intent / scheme / simctl
6. 流式输出日志；非 HMR 场景文件变化触发 reload
7. Ctrl+C 清理：撤销 adb reverse、关闭 Whistle（可选）
```

### 10.6 多设备

- Android：`--device <serial>`；多设备独立 `adb reverse`（端口可复用）。
- iOS：`xcrun simctl list devices` / `xcrun xctrace list devices`。
- Whistle 规则共享；二维码显示实际 LAN IP / 端口。

### 10.7 与手机的两条连接

“连接手机”不是一条链路，拆成两条：

| 通道 | 用途 | Android | iOS |
|---|---|---|---|
| 控制通道 | 安装、拉起、reload、日志、清缓存 | `adb`（USB / Wi-Fi adb） | `xcrun devicectl` / `simctl`（仅 macOS） |
| 数据通道 | WebView 的 HTTP(S) 走代理 | Wi-Fi 代理，或 `adb reverse` + `127.0.0.1:8899` | Wi-Fi 代理（局域网 / 热点） |

落地方式：

- **Android USB（最稳）**：`adb reverse tcp:8899 tcp:8899`，手机 Wi-Fi 代理填 `127.0.0.1:8899`；不依赖局域网、防火墙、AP 隔离。
- **Android Wi-Fi**：代理填 `<开发机 LAN IP>:8899`；控制台二维码直接给出。
- **iOS 真机**：只能 `<开发机 LAN IP>:8899`；USB 用于安装/日志，标准 usbmux 只做 host→device 转发，不做“设备→开发机”的反向代理。AP 隔离时用手机热点或 Mac 共享网络。
- **模拟器**：iOS 模拟器直接用 `127.0.0.1:8899`；Android 模拟器用 `10.0.2.2:8899`（或 `adb reverse` 后用 `127.0.0.1`）。

自动化的边界（要提前接受）：

- **CA 信任必须手动点**：Android 设置里安装用户证书；iOS 下载描述文件后在“证书信任设置”里打开完全信任。做不到全自动（除非 root / MDM）。
- **iOS 代理设置必须手动**：WKWebView 走系统代理，没有公开的 per-app 代理 API；工具只能把步骤和二维码给到。
- **Android 可半自动**：`adb` 能设/清全局代理、能 `adb reverse`，但用户证书安装仍要手点；debug 包用 `network_security_config` 信任用户 CA。
- **release 不受影响**：以上都只存在于 debug 构建和开发机。

### 10.8 构建工具无关性

核心只依赖三件事：**启动命令、服务 URL、就绪信号**。不要调用 Vite API，也不假设目录结构。

| 构建工具 | dev 命令 | 默认端口 | Host 校验 |
|---|---|---|---|
| Vite | `vite` | 5173 | `server.allowedHosts` |
| Webpack Dev Server | `webpack serve` | 8080 | `allowedHosts` / `disableHostCheck` |
| Rspack CLI | `rspack serve` | 8080 | `devServer.allowedHosts` |
| Angular CLI | `ng serve` | 4200 | `allowedHosts` / `disableHostCheck` |
| Next.js | `next dev` | 3000 | 一般无 |
| 静态服务器 | `npx serve dist` / `python -m http.server` | 3000 / 8000 | 无 |

通用处理：

1. **按 Host 整站转发**到 `devUrl`，不按单个资源路径写规则；API / OAuth 用 `passthrough` 前缀排除。
2. **WebSocket 也按 Host 转发**。HMR 的 WS 路径因工具而异，不写死路径；P1 验证 Whistle 的 WS 转发，失败则降级。
3. **`Invalid Host header`**：开 `hostRewrite`，把请求 Host 改成 `127.0.0.1:<port>`；或在 dev server 放行生产域名。
4. **生产子路径 vs 本地根路径**：用 `basePath` 生成 path rewrite；同时确认构建工具的 `base` / `publicPath`。
5. **HMR 客户端写死 `localhost`**：把它配成 `wss://生产域名/...`；工具按构建工具给预设片段。
6. **最坏降级**：文件监听 + WebView reload（chokidar + `adb shell am broadcast` / dev client），不阻塞主流程。

一句话：构建工具只影响“启动命令 + HMR 配置”，不影响同源代理原理。

---

## 11. 安全与发布隔离

- **debug-only**：dev 入口放 `src/debug`（Android）、Debug 配置（iOS）。
- **release 不含**：dev Activity、dev 菜单、明文放行、用户 CA 信任、Whistle 规则。
- **URL 白名单**：只允许 localhost、局域网段、配置里的生产域名。
- **token**：调试注入的 token 不写日志、不落盘明文；退出清理。
- **证书**：Whistle CA 只装在测试手机；release 的 network security config 不含 `debug-overrides`。
- **CI 检查**：release manifest 不含 `usesCleartextTraffic` / debug Activity / debug network security config。
- **评审清单**：每个平台的 dev 入口都要检查"release 是否可达"。

---

## 12. 实施计划与验收

### 12.1 阶段

| 阶段 | 内容 | 工期 | 产出 |
|---|---|---|---|
| P0 盘点 | 确认 SSO 清单、pinning/WebAuthn/mTLS、Android debug 包、Windows 是否需要 iOS | 0.5 人天 | 现状表 + 风险清单 |
| P1 同源 Spike | Whistle + 任一 dev server + 一条真实 SSO 全链路（Android + iOS）；**不改原生代码** | 1 人天 | Go/No-Go 结论；规则模板 |
| P2 核心 + CLI + 控制台 | daemon、配置、编排、二维码、日志、多设备、doctor、Vue 控制台 | 2 人天 | `hybrid-dev` MVP |
| P2.5 VSCode 插件 | 命令面板、状态栏、设备树、Webview 嵌控制台 | 1–2 人天 | VSIX |
| P3 直连模式（可选） | Android debug 入口 + `adb reverse`；iOS 局域网 | 1 人天 | 直连调试 |
| P4 预览模式 | 任意构建产物 / 静态服务器映射 | 0.5 人天 | 发版前检查 |
| P5 Android 原生拦截（可选） | `shouldInterceptRequest` | 2 人天 | 去代理优化 |
| P6 桌面壳（可选） | Tauri / Electron 包同一套控制台 | 2–3 人天 | 安装包 |
| **合计** | | **3–4 人天（核心 MVP）** | |
| | | **4–6 人天（+VSCode 插件）** | |
| | | **5–7 人天（+直连/预览）** | |
| | | **9–12 人天（完整，含桌面壳/原生拦截）** | |

> P1 在 macOS 上做 Android + iOS；Windows 上只做 Android。Windows 版核心的跨平台验证另加 0.5 人天。

### 12.2 验收标准

- 修改一个 Vue 组件，Android / iOS App **≤3 秒**更新，不重新打 native 包。
- 选定的 SSO 流程在 **Android 真机 + iOS 真机** 完整走通，不部署服务器。
- 一条命令在"同源 / 直连"之间切换。
- 换一个非 Vite 的 Web 项目（如 Webpack），只改配置、不改核心，能跑通同源模式。
- VSCode 插件能启动/停止 daemon，看到设备、日志，并在 Webview 里打开控制台。
- 构建产物能在真实壳里通过预览模式验证。
- 工具在 **Windows** 上完成 Android 全流程；在 **macOS** 上完成 Android + iOS。
- release 包确认不存在 dev Activity、明文放行、用户 CA 信任。
- 新同事按文档 ≤30 分钟完成环境搭建。

### 12.3 交付物

- `hybrid-dev` daemon / CLI 与配置模板（Windows/macOS 通用）。
- Vue3 控制台（浏览器可用，也可嵌进 VSCode Webview）。
- VSCode 插件 VSIX。
- Android debug Activity 示例；iOS URL Scheme / 调试入口片段。
- Whistle 规则模板与手机证书安装文档。
- SSO 接入手册。
- 一页"日常开发怎么用"的 cheat sheet。

---

## 13. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| Windows 无法构建/调试 iOS | 确定 | 高 | Windows 只做 Android；iOS 用 Mac / 远程 Mac / CI |
| 公司网络 AP 隔离 | 中 | 高 | Android 用 `adb reverse tcp:8899`；iOS 用热点/共享网络 |
| Windows 防火墙拦截 8899/5173 | 中 | 中 | 首次运行允许专用网络；doctor 给出 `netsh` 提示 |
| Whistle + dev server HMR 调不通 | 中 | 中 | P1 spike；退化文件监听 + reload |
| 构建工具差异（HMR WS / Host 校验 / basePath） | 高 | 中 | 核心只依赖命令 + URL；`hostRewrite`；按工具给预设；HMR 失败降级 reload |
| VSCode 插件 / 桌面壳与 daemon 生命周期不同步 | 中 | 低 | daemon 独立进程 + 健康检查；壳只做启停和展示 |
| iOS 证书安装/信任摩擦 | 高 | 中 | 图文文档；模拟器优先；真机按需 |
| SSO 证书固定（pinning） | 低 | 高 | debug 关闭 pinning；或 Android 原生拦截；安全评审 |
| WebAuthn / Passkey | 中 | 高 | 必须同源；Whistle 方案 |
| mTLS / 客户端证书 | 低 | 高 | Whistle 无法提供客户端证书；改 staging 或原生拦截 |
| 生产 CSP / SRI 阻止 dev 资源 | 中 | 中 | dev 放宽 CSP；关闭 SRI；P1 验证 |
| WebView 缓存 / Service Worker 残留 | 中 | 低 | `clean` 命令；dev 禁用 SW |
| 调试入口泄漏到 release | 低 | 高 | source set + CI 静态检查 + 评审清单 |
| Windows/macOS 命令差异 | 中 | 低 | Node + execa，避免 shell 脚本；CI 双平台跑 doctor |

---

## 14. 参考资料

- Capacitor Live Reload：https://capacitorjs.com/docs/guides/live-reload
- Capacitor Server 配置：https://capacitorjs.com/docs/config
- Cordova CLI / Live Reload：https://cordova.apache.org/docs/en/latest/guide/cli/
- React Native Debugging / Dev Menu：https://reactnative.dev/docs/debugging
- Whistle：https://github.com/avwo/whistle
- Whistle 文档：https://wproxy.org/whistle/
- AndroidX WebViewAssetLoader：https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader
- Android WebView 远程调试：https://developer.chrome.com/docs/devtools/remote-debugging/webviews/
- adb reverse：https://developer.android.com/tools/adb#forwardingports
- Vite Server Options：https://vitejs.dev/config/server-options
- WKWebView：https://developer.apple.com/documentation/webkit/wkwebview
- Safari Web Inspector：https://developer.apple.com/safari/tools/
- mitmproxy（Whistle 替代）：https://mitmproxy.org/

---

## 附录 A：SSO 盘点模板

| # | 业务入口 | 协议 | IdP | 回调地址 | 会话方式 | 打开位置 | Pinning | MFA/WebAuthn | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| 1 |  | OAuth2/OIDC |  |  | Cookie/Token | WebView/系统浏览器/原生 SDK | 是/否 |  |  |
| 2 |  | SAML |  |  | Cookie |  |  |  |  |
| 3 |  | 自研 |  |  |  |  |  |  |  |

## 附录 B：Whistle 规则模板（语法以 P1 验证为准）

```
# 先放行 API / SSO / 支付回调
app.example.com/api/       direct://
app.example.com/oauth/     direct://
app.example.com/sso/       direct://
app.example.com/pay/       direct://

# 其余静态资源兜底到本地 dev server
app.example.com/           proxy://127.0.0.1:5173

# 构建产物预览时改成 4173
# app.example.com/         proxy://127.0.0.1:4173
```

注意：

- 规则按顺序匹配，API/SSO 必须放在兜底规则之前。
- `direct://` 表示直连真实服务器；如当前 Whistle 版本行为不符，改用 `excludeFilter://` 或对应 passthrough 写法。
- Vite 需要配置 `server.allowedHosts: ['app.example.com']`；Webpack / Rspack 配 `allowedHosts`，或用工具的 `hostRewrite`。
- HMR WebSocket 是否被 `proxy://` 正常转发是 P1 验证点；不通就退化为文件监听 + reload。

## 附录 C：Web dev server 配置示例

```ts
// vite.config.ts（Vite）
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['app.example.com', 'localhost'],
    // HMR 通过 Whistle 代理时如遇问题，再按实际调试：
    // hmr: { host: 'app.example.com', protocol: 'wss', clientPort: 443 },
  },
});
```

```js
// webpack.config.js（webpack-dev-server）
module.exports = {
  devServer: {
    host: '0.0.0.0',
    port: 8080,
    allowedHosts: 'all',          // 或 ['app.example.com']
    client: {
      webSocketURL: 'wss://app.example.com/ws', // HMR 走生产域名
    },
  },
};
```

> 其他构建工具同理：放行 Host、把 HMR 的 WS 地址指到生产域名；工具负责生成 Whistle 规则，不依赖具体构建工具。

## 附录 D：P1 同源方案验证清单

> 目标：用一条真实 SSO 流程，验证"生产域名 + 本地 dev server"是否可行。  
> 宿主：Windows 或 macOS；App：Android；iOS 需 macOS。预计 0.5–1 天。

### D1. 准备

- [ ] 测试账号、生产域名（例如 `app.example.com`）。
- [ ] 手机可改 Wi-Fi 代理。
- [ ] Android 测试机是可信任用户 CA 的 debug 包（或已 root）。
- [ ] iOS 测试机可安装描述文件并开启完全信任（仅 macOS 流程）。
- [ ] 列出 SSO 的 `redirect_uri` 和 token 接口路径。
- [ ] 确认是否有 Service Worker、CSP/SRI、mTLS、IdP 设备指纹/IP 白名单。

### D2. 启动本地环境

```bash
npm i -g whistle
w2 start                     # 默认 8899
npm run dev -- --host 0.0.0.0 --port 5173
```

dev server 配置（以 Vite 为例，其他工具见 10.8）：

```ts
server: {
  host: '0.0.0.0',
  port: 5173,
  strictPort: true,
  allowedHosts: ['app.example.com'],
}
```

### D3. 配置 Whistle 规则

```
app.example.com/api/     direct://
app.example.com/oauth/   direct://
app.example.com/sso/     direct://
app.example.com/         proxy://127.0.0.1:5173
```

### D4. 手机代理 + 证书

- **Android（推荐）**：
  ```bash
  adb reverse tcp:8899 tcp:8899
  ```
  手机 Wi-Fi 代理 → `127.0.0.1:8899`；浏览器打开 `http://rootca.pro` 安装 CA。
- **Android（局域网）**：手机 Wi-Fi 代理 → `<开发机 LAN IP>:8899`。
- **iOS**：手机 Wi-Fi 代理 → `<开发机 LAN IP>:8899`；Safari 安装描述文件 → 设置 → 通用 → 关于本机 → 证书信任设置 → 完全信任。
- **Windows 防火墙**：允许 Node.js 在专用网络接收连接；必要时 `netsh advfirewall` 加 8899/5173 入站规则。
- **macOS 防火墙**：系统设置 → 网络 → 防火墙，允许 Node 传入连接。

### D5. 验证项

- [ ] App 打开后，页面 HTML/JS 来自本地 dev server（改一个标题立刻看到）。
- [ ] HMR 生效（改 Vue 组件不手动刷新）；若不通，记录 dev server / Whistle 日志，评估自动 reload 兜底。
- [ ] API 请求打到真实服务器，Cookie 正常。
- [ ] SSO 跳转、回调、换 token、写 Cookie 全链路通过。
- [ ] 刷新/冷启动后登录态保持。
- [ ] 清空 WebView 缓存/Service Worker 后首次加载正常。
- [ ] 生产 CSP / SRI 没有拦截 dev server 的资源。
- [ ] `location.origin` 仍是生产域名，页面 URL 没有 localhost / 127.0.0.1。

### D6. Go/No-Go

- **Go**：D5 全部通过 → 进入 CLI 封装。
- **条件 Go**：HMR 不通但自动 reload 可用 → 先做 CLI，HMR 后续优化。
- **No-Go**：SSO 因 pinning / IdP 策略 / WebAuthn / mTLS 无法通过 → Android 原生拦截或 token 注入；iOS 重新评估（可能需要 staging）。

---

## 附：P0 还需要确认的问题

已确认：App = Android/iOS 原生壳；工具宿主 = Windows/macOS；生产 Web 远程 URL；SSO 在手机端；Vue3（构建工具待定）；工具形态 = 核心 daemon + 控制台 + 薄壳（VSCode 插件优先）。

还需要确认：

1. Windows 开发者是否需要构建/调试 iOS？如果需要，准备 Mac / 远程 Mac / CI。
2. 生产环境除远程 URL 外，是否还有本地 assets 离线包？
3. 列出所有 SSO 入口：协议、IdP、`redirect_uri`、Cookie 域、是否在 WebView 内。
4. 是否有证书固定、IP 白名单、WebAuthn / Passkey、mTLS？
5. 测试手机能否改 Wi-Fi 代理、安装根证书？Android 测试包能否出 debug 构建？
6. 测试网络是否 AP 隔离？能否用 Android `adb reverse` / 热点兜底？
7. Web 实际用哪个构建工具？dev server 端口、HMR 方式、是否有 `base` / `publicPath` 子路径？
8. 团队是否统一用 VSCode？如果有人用 WebStorm，桌面端优先级要提高。

第 1、3、5 项确认后，P1 可以直接开工。
