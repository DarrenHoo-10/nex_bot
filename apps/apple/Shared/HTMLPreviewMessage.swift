import SwiftUI
import WebKit
import NexMarkdown

struct HTMLPreviewMessage: View {
    let source: String
    let complete: Bool
    var pending = false
    @StateObject private var model = HTMLPreviewModel()
    @State private var fullscreen = false

    private var eligible: Bool { complete && !pending && source.utf16.count <= HTMLPreview.sourceLimit }
    private var status: String { pending ? "生成中" : !complete ? "内容未完成" : source.utf16.count > HTMLPreview.sourceLimit ? "内容过大" : model.status }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            if fullscreen { Color.clear.frame(height: model.height) }
            else if model.running { HTMLPreviewWebView(model: model).frame(height: model.height) }
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border))
        #if os(macOS)
        .sheet(isPresented: $fullscreen) { expanded.frame(minWidth: 280, idealWidth: 1000, minHeight: 300, idealHeight: 700) }
        #else
        .fullScreenCover(isPresented: $fullscreen) { expanded }
        #endif
        .onAppear { model.configure(source: source, eligible: eligible) }
        .onChange(of: source) { _, _ in model.configure(source: source, eligible: eligible) }
        .onChange(of: eligible) { _, _ in model.configure(source: source, eligible: eligible) }
        .onReceive(model.$escape) { value in if value { fullscreen = false; model.escape = false } }
        .onDisappear { if !fullscreen { model.stop() } }
    }

    private var expanded: some View {
        VStack(spacing: 0) { toolbar; if model.running { HTMLPreviewWebView(model: model) } else { Spacer() } }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            Text("预览").fontWeight(.semibold)
            Text(status).foregroundStyle(Theme.muted)
            Spacer(minLength: 0)
            if model.running { Button("停止") { model.stop() } }
            if eligible { Button("重新运行") { model.run() } }
            Button(fullscreen ? "退出全屏" : "全屏") { fullscreen.toggle() }
        }.font(.caption).buttonStyle(.borderless).padding(10)
    }
}

@MainActor private final class HTMLPreviewMessages: NSObject, WKScriptMessageHandler {
    weak var owner: HTMLPreviewModel?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let data = message.body as? [String: Any] else { return }
        owner?.receive(data)
    }
}

@MainActor final class HTMLPreviewModel: NSObject, ObservableObject, WKNavigationDelegate {
    @Published var height: CGFloat = 240
    @Published var status = "加载中"
    @Published var running = false
    @Published var escape = false
    private(set) var view: WKWebView?
    private var source = "", eligible = false, id = ""
    private var timeout: Task<Void, Never>?
    private var lastResize = Date.distantPast

    func configure(source: String, eligible: Bool) {
        guard source != self.source || eligible != self.eligible || (eligible && view == nil) else { return }
        self.source = source; self.eligible = eligible
        if eligible { run() } else { stop() }
    }

    func run() {
        guard eligible else { return }
        stop(); id = UUID().uuidString; status = "加载中"; height = 240
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let handler = HTMLPreviewMessages(); handler.owner = self
        configuration.userContentController.add(handler, contentWorld: .defaultClient, name: "nexHTMLStatus")
        configuration.userContentController.addUserScript(WKUserScript(source: "addEventListener('message',e=>{if(e.source===window&&e.data?.channel==='nex-html-preview')webkit.messageHandlers.nexHTMLStatus.postMessage(e.data)})", injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; view = web; running = true
        // CSP confines resources; the native rule also blocks network requests
        // should a WebKit version handle a content directive differently.
        let generation = id
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "nex-html-preview-offline-v1", encodedContentRuleList: "[{\"trigger\":{\"url-filter\":\"^https?://\"},\"action\":{\"type\":\"block\"}}]") { [weak self, weak web] rules, error in
            Task { @MainActor in
                guard let self, let web, self.id == generation else { return }
                guard error == nil, let rules else { self.status = "无法加载预览"; self.running = false; return }
                web.configuration.userContentController.add(rules)
                web.loadHTMLString(HTMLPreview.shell, baseURL: nil)
            }
        }
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled, let self, self.id == generation, self.status == "加载中" else { return }
            self.status = "加载超时"
        }
    }

    func stop() {
        id = "" // Invalidate an in-flight content-rule compilation before disposal.
        timeout?.cancel(); timeout = nil
        view?.stopLoading(); view?.navigationDelegate = nil
        view?.configuration.userContentController.removeScriptMessageHandler(forName: "nexHTMLStatus", contentWorld: .defaultClient)
        view?.loadHTMLString("", baseURL: nil); view = nil; running = false; status = "已停止"
    }

    func receive(_ data: [String: Any]) {
        guard running, data["id"] as? String == id, let type = data["type"] as? String else { return }
        if type == "ready" { timeout?.cancel(); if status != "运行出错" { status = "" } }
        if type == "error" { timeout?.cancel(); status = "运行出错" }
        if type == "escape" { escape = true }
        if type == "resize", let number = data["height"] as? NSNumber, number.doubleValue.isFinite, number.doubleValue > 0, Date().timeIntervalSince(lastResize) > 0.08 {
            lastResize = Date(); height = min(900, max(160, CGFloat(number.doubleValue)))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === view, running else { return }
        let data: [String: String] = ["channel": "nex-html-init", "id": id, "source": source]
        // The source is a JSON string argument, never JavaScript program text.
        guard let encoded = try? JSONSerialization.data(withJSONObject: data), let json = String(data: encoded, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.postMessage(\(json),'*')", completionHandler: nil)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url?.absoluteString ?? ""
        let initial = action.navigationType == .other && url == "about:blank"
        let content = action.targetFrame?.isMainFrame == false && url.hasPrefix("data:text/html;base64,")
        decisionHandler(initial || content ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { status = "预览已停止"; running = false; timeout?.cancel() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { status = "无法加载预览"; timeout?.cancel() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { status = "无法加载预览"; timeout?.cancel() }
}

// Moving the same WKWebView between inline and sheet containers preserves the
// page and its JS state. Only Stop, rerun, a new source or disposal destroys it.
@MainActor struct HTMLPreviewWebView {
    @ObservedObject var model: HTMLPreviewModel
}
#if os(macOS)
extension HTMLPreviewWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { NSView() }
    func updateNSView(_ container: NSView, context: Context) {
        guard let web = model.view, web.superview !== container else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        web.removeFromSuperview(); web.frame = container.bounds; web.autoresizingMask = [.width, .height]; container.addSubview(web)
    }
}
#else
extension HTMLPreviewWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView { UIView() }
    func updateUIView(_ container: UIView, context: Context) {
        guard let web = model.view, web.superview !== container else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        web.removeFromSuperview(); web.frame = container.bounds; web.autoresizingMask = [.flexibleWidth, .flexibleHeight]; container.addSubview(web)
    }
}
#endif
