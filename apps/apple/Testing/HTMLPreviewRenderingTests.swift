import XCTest
import SwiftUI
import WebKit
import NexMarkdown
@testable import NexRenderFixture

final class HTMLPreviewRenderingTests: XCTestCase {
    @MainActor private func wait(_ check: () -> Bool) async throws {
        for _ in 0..<100 {
            if check() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Preview did not reach expected state")
    }

    @MainActor func testProductionHTMLRuntimeAndLifecycle() async throws {
        let model = HTMLPreviewModel()
        let source = """
        <style>body{height:360px}</style><input type="range" value="20"><output></output><canvas width="10" height="10"></canvas><svg><rect width="10" height="10"/></svg>
        <script>
        const input=document.querySelector('input'),output=document.querySelector('output');
        input.oninput=()=>output.textContent=input.value;input.value='42';input.dispatchEvent(new Event('input'));
        if(output.textContent!=='42')throw Error('DOM input');
        document.querySelector('canvas').getContext('2d').fillRect(0,0,10,10);
        let isolated=false;try{parent.document.body}catch{isolated=true}if(!isolated)throw Error('parent access');
        if(typeof window.nex!=='undefined'||typeof window.NexAndroid!=='undefined'||window.webkit?.messageHandlers?.nexHTMLStatus)throw Error('native bridge');
        let storage=false;try{localStorage.setItem('fixture','1')}catch{storage=true}if(!storage)throw Error('storage');
        if(typeof RTCPeerConnection!=='undefined')throw Error('RTC');
        let count=500;addEventListener('message',e=>{if(e.data==='next')parent.postMessage({channel:'nex-html-content',type:'resize',height:++count},'*')});
        </script>
        """
        model.configure(source: source, eligible: false)
        XCTAssertNil(model.view)
        model.configure(source: source, eligible: true)
        let web = try XCTUnwrap(model.view)
        web.frame = CGRect(x: 0, y: 0, width: 390, height: 500)
        #if os(macOS)
        let host = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
        host.contentView = web; host.orderFront(nil)
        defer { host.orderOut(nil) }
        #else
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let host = UIWindow(windowScene: scene), controller = UIViewController()
        controller.view.addSubview(web); host.rootViewController = controller; host.makeKeyAndVisible()
        defer { host.isHidden = true }
        #endif
        defer { model.stop() }
        // Ready and the first ResizeObserver measurement arrive independently.
        try await wait { model.status.isEmpty && model.height > 300 }
        XCTAssertGreaterThan(model.height, 300)
        XCTAssertFalse(web.configuration.websiteDataStore.isPersistent)
        // A layout/fullscreen host may reparent this WKWebView, never reload it.
        model.configure(source: source, eligible: true)
        XCTAssertTrue(web === model.view)
        try await Task.sleep(for: .milliseconds(200))
        _ = try await web.evaluateJavaScript("document.querySelector('iframe').contentWindow.postMessage('next','*')")
        try await wait { model.height == 501 }
        web.frame.size.width = 800
        try await Task.sleep(for: .milliseconds(300))
        _ = try await web.evaluateJavaScript("document.querySelector('iframe').contentWindow.postMessage('next','*')")
        try await wait { model.height == 502 }
        model.stop(); XCTAssertNil(model.view); XCTAssertFalse(model.running)
        model.run(); XCTAssertFalse(web === model.view)
        try await wait { model.status.isEmpty }
        model.configure(source: "<script>throw Error('fixture')</script>", eligible: true)
        try await wait { model.status == "运行出错" }
        model.configure(source: "partial", eligible: false)
        XCTAssertNil(model.view)
    }
}
