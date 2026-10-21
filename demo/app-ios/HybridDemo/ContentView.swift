import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var model = WebViewModel()

    private let background = Color(red: 0.043, green: 0.071, blue: 0.125)
    private let panel = Color(red: 0.067, green: 0.110, blue: 0.180)
    private let accent = Color(red: 0.369, green: 0.918, blue: 0.831)
    private let muted = Color(red: 0.576, green: 0.639, blue: 0.729)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Hybrid Live Reload")
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(.white)

            Text("同一个 URL：代理开启时加载本地代码，代理关闭时加载生产代码。")
                .font(.system(size: 12))
                .foregroundColor(muted)

            HStack(spacing: 8) {
                TextField("http://电脑IP:8080", text: $model.urlString)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
                    .keyboardType(.URL)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(.white)
                    .padding(10)
                    .background(panel)
                    .cornerRadius(10)
                    .onSubmit { model.load() }

                Button(action: { model.load() }) {
                    Text("加载")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(background)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 11)
                        .background(accent)
                        .cornerRadius(10)
                }
            }

            HStack(spacing: 8) {
                Button(action: { model.reload() }) {
                    Text("重新加载")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(panel)
                        .cornerRadius(10)
                }

                Button(action: { model.clearWebData() }) {
                    Text("清空 Cookie")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(panel)
                        .cornerRadius(10)
                }
            }

            Text(model.status)
                .font(.system(size: 11))
                .foregroundColor(muted)
                .lineLimit(2)

            WebView(model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(panel, lineWidth: 1)
                )

            Text("模拟器：代理填 127.0.0.1:8899，打开 http://127.0.0.1:8080\n真机：手机与电脑同一 Wi-Fi，代理填 电脑IP:8899，打开 http://电脑IP:8080")
                .font(.system(size: 10))
                .foregroundColor(muted)
                .lineSpacing(2)
        }
        .padding(16)
        .background(background.ignoresSafeArea())
    }
}

struct WebView: UIViewRepresentable {
    let model: WebViewModel

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear

        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }

        model.attach(webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let model: WebViewModel

        init(model: WebViewModel) {
            self.model = model
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.status = "已加载：\(webView.url?.absoluteString ?? "")"
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            model.status = "加载失败：\(error.localizedDescription)"
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            model.status = "加载失败：\(error.localizedDescription)"
        }
    }
}

final class WebViewModel: ObservableObject {
    @Published var urlString = "http://127.0.0.1:8080"
    @Published var status = "准备加载…"

    private weak var webView: WKWebView?

    private var normalizedURLString: String {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return "http://127.0.0.1:8080"
        }
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            return trimmed
        }
        return "http://\(trimmed)"
    }

    private var url: URL {
        URL(string: normalizedURLString) ?? URL(string: "http://127.0.0.1:8080")!
    }

    func attach(_ webView: WKWebView) {
        self.webView = webView
        load()
    }

    func load() {
        urlString = normalizedURLString
        status = "正在加载…"
        webView?.load(URLRequest(url: url))
    }

    func reload() {
        status = "正在重新加载…"
        webView?.reload()
    }

    func clearWebData() {
        let dataStore = WKWebsiteDataStore.default()
        let dataTypes = WKWebsiteDataStore.allWebsiteDataTypes()

        dataStore.removeData(
            ofTypes: dataTypes,
            modifiedSince: .distantPast
        ) { [weak self] in
            HTTPCookieStorage.shared.removeCookies(since: .distantPast)
            URLCache.shared.removeAllCachedResponses()
            DispatchQueue.main.async {
                self?.status = "Cookie 与 WebKit 数据已清空"
                self?.webView?.reload()
            }
        }
    }
}
