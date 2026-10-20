import SwiftUI
import WebKit
import NexMarkdown

/// HTML has already passed StaticHTML.sanitize. No account cookies, file base
/// URL, model scripts or network subresources. The isolated chart renderer has
/// only a bounded numeric height callback, with no application capabilities.
struct StaticHTMLMessage: View {
    let fragment: String
    let fontSize: CGFloat
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL
    @State private var height: CGFloat = 40

    var body: some View {
        GeometryReader { geometry in
            StaticHTMLWebView(
                html: StaticHTML.document(fragment: fragment, fontSize: Double(fontSize), dark: colorScheme == .dark),
                width: geometry.size.width,
                height: $height,
                openLink: { url in if StaticHTML.safeLink(url.absoluteString) { openURL(url) } }
            )
            .frame(width: geometry.size.width, height: height)
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
    }
}

@MainActor struct StaticHTMLWebView {
    let html: String
    let width: CGFloat
    @Binding var height: CGFloat
    let openLink: (URL) -> Void

    func makeCoordinator() -> StaticHTMLCoordinator { StaticHTMLCoordinator(height: $height, openLink: openLink) }

    func makeWebView(_ coordinator: StaticHTMLCoordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(coordinator, contentWorld: .defaultClient, name: "nexChartHeight")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = coordinator
        #if os(macOS)
        view.setValue(false, forKey: "drawsBackground")
        #else
        view.isOpaque = false
        view.backgroundColor = .clear
        #endif
        return view
    }

    func update(_ view: WKWebView, coordinator: StaticHTMLCoordinator) {
        coordinator.height = $height
        coordinator.openLink = openLink
        if coordinator.html != html {
            coordinator.html = html
            coordinator.navigation = view.loadHTMLString(html, baseURL: nil)
        } else {
            DispatchQueue.main.async { coordinator.measure(view) }
        }
    }
}

#if os(macOS)
extension StaticHTMLWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) { update(view, coordinator: context.coordinator) }
    static func dismantleNSView(_ view: WKWebView, coordinator: StaticHTMLCoordinator) { view.stopLoading(); view.navigationDelegate = nil; view.configuration.userContentController.removeScriptMessageHandler(forName: "nexChartHeight", contentWorld: .defaultClient) }
}
#else
extension StaticHTMLWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) { update(view, coordinator: context.coordinator) }
    static func dismantleUIView(_ view: WKWebView, coordinator: StaticHTMLCoordinator) { view.stopLoading(); view.navigationDelegate = nil; view.configuration.userContentController.removeScriptMessageHandler(forName: "nexChartHeight", contentWorld: .defaultClient) }
}
#endif

@MainActor final class StaticHTMLCoordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var html = ""
    var navigation: WKNavigation?
    var height: Binding<CGFloat>
    var openLink: (URL) -> Void

    init(height: Binding<CGFloat>, openLink: @escaping (URL) -> Void) { self.height = height; self.openLink = openLink }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nexChartHeight", message.frameInfo.isMainFrame,
              let number = message.body as? NSNumber, number.doubleValue.isFinite else { return }
        let next = min(8192, max(1, CGFloat(number.doubleValue)))
        if abs(height.wrappedValue - next) > 0.5 { height.wrappedValue = next }
    }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === self.navigation else { return }
        let snapshot = html
        // Only the bundled renderer runs, in the app's isolated world. Model
        // output is parsed as bounded JSON; page scripts remain disabled.
        view.evaluateJavaScript(StaticHTML.chartScript, in: nil, in: .defaultClient) { [weak self, weak view] _ in
            guard let self, let view, self.html == snapshot else { return }
            self.measure(view)
        }
    }

    func measure(_ view: WKWebView) {
        let snapshot = html
        // Trusted, app-owned measurement in an isolated content world; page JS stays disabled.
        view.evaluateJavaScript("Math.ceil(document.body.getBoundingClientRect().height)", in: nil, in: .defaultClient) { [weak self] result in
            guard let self, self.html == snapshot,
                  case .success(let value) = result, let number = value as? NSNumber else { return }
            let next = min(8192, max(1, CGFloat(number.doubleValue)))
            if abs(self.height.wrappedValue - next) > 0.5 { self.height.wrappedValue = next }
        }
    }

    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .linkActivated {
            if let url = action.request.url, StaticHTML.safeLink(url.absoluteString) { openLink(url) }
            decisionHandler(.cancel)
        } else {
            // Only the app's loadHTMLString document may navigate this web view.
            decisionHandler(action.navigationType == .other && action.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
        }
    }
}
