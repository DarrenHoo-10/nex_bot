import SwiftUI
import UniformTypeIdentifiers
import NexClientKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Drafts survive switching between sessions.
@MainActor
enum AgentDrafts {
    static var texts: [CliSessionKey: String] = [:]
    static var images: [CliSessionKey: [CliImageUpload]] = [:]
    static var models: [CliSessionKey: String] = [:]
    static var appliedModels: [CliSessionKey: String] = [:]
    static var efforts: [CliSessionKey: String] = [:]
    static var appliedEfforts: [CliSessionKey: String] = [:]
    /// The permission mode picked in the + menu, and whether the CLI still has to take it.
    static var permissions: [CliSessionKey: (mode: CliPermissionMode, pending: Bool)] = [:]
}

private enum AgentTab: Hashable { case terminal, chat }

/// A message sent from this screen that the session's records do not hold yet: it shows at once, with the dots under it.
struct AgentPendingSend: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var uploading = false
    var nativeQueued = false
    /// the items the transcript held when it was sent
    let known: Set<String>

    /// Still waiting: no new user item with its text, and nothing of the agent after it.
    func waiting(in items: [CliItem]) -> Bool {
        if uploading { return true }
        let plain = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !items.contains { item in
            guard !known.contains(item.id) else { return false }
            switch item.kind {
            case .user: return item.text.trimmingCharacters(in: .whitespacesAndNewlines) == plain
            case .turn: return false
            case .notice: return !item.text.isEmpty
            default: return true
            }
        }
    }
}

/// One session: terminal or transcript, the cards of what it asks for, and the composer.
struct AgentSessionDetail: View {
    let model: CliAgentsModel
    let workspace: WorkspaceStore
    let key: CliSessionKey
    let openAssistant: (String) -> Void
    /// The session continues under another key.
    let onKeyChange: (CliSessionKey) -> Void
    @State private var tab: AgentTab = .terminal
    @State private var forking = false
    @State private var forkItemId: String?
    @State private var branchedChat: CliForkResult?
    @State private var guides: [AgentGuide] = []
    @State private var pending: [AgentPendingSend] = []
    /// A model call that failed for good while this screen was open.
    @State private var failure: String?
    @State private var failuresSeen: Set<String>?
    @State private var openedAt = Date()
    @State private var expandedActivities: Set<String> = []
    @State private var inspectorOpen = false
    @State private var inspectorTab: AgentWorkbenchTab = .git
    @State private var noteDraft: AgentNoteDraft?

    private var session: CliSession? { model.sessions.first { $0.key == key } }

    var body: some View {
        Group {
            if let session {
                content(session)
            } else {
                Text("会话不存在").foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            model.openSession(key)
            // a session just started here opens on its conversation, where the first message shows
            if model.echoes[key] != nil { tab = .chat }
        }
        .onDisappear { model.closeSession(key) }
        .onChange(of: key) { _, _ in pending = []; failuresSeen = nil; openedAt = Date() }
        .onChange(of: model.transcript(key).items) { _, items in noteFailures(items) }
        .alert("模型调用失败", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("知道了", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
        .sheet(isPresented: $forking, onDismiss: {
            forkItemId = nil
            branchedChat = nil
        }) {
            if let branchedChat {
                FinanceTopicsView(workspace: workspace, botID: branchedChat.botId, conversationID: branchedChat.conversationId,
                                  onClose: { forking = false })
                    #if os(macOS)
                    .frame(minWidth: 520, minHeight: 460)
                    #endif
            } else if let session {
                AgentForkSheet(model: model, workspace: workspace, session: session, itemId: forkItemId) { result in
                    if forkItemId != nil {
                        branchedChat = result
                    } else {
                        forking = false
                        openAssistant(result.botId)
                    }
                }
            }
        }
    }

    private func content(_ session: CliSession) -> some View {
        let attach = CliSessions.canAttach(session)
        let shown = attach ? tab : .chat
        // handled cards show their outcome for a moment, then leave the space above the box
        let cards = model.shownCards(key)
        let mainColumn = VStack(spacing: 0) {
            header(session, attach: attach, shown: shown)
            Group {
                if shown == .terminal {
                    AgentTerminalPane(model: model, key: key)
                } else {
                    AgentTranscript(model: model, key: key, expandedActivities: $expandedActivities, guides: guides.filter { $0.key == key }, engine: session.engine, active: session.state == .running || session.state == .waiting, working: session.online && session.state == .running ? "执行中" : nil, pending: pending,
                                    branch: workspace.bots.isEmpty ? nil : { itemId in
                                        forkItemId = itemId
                                        forking = true
                                    },
                                    onNote: { item in
                                        noteDraft = AgentNoteDraft(messageId: item.id, quote: item.text)
                                        inspectorTab = .notes
                                        inspectorOpen = true
                                    })
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if !cards.isEmpty {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(cards) { record in
                            AgentRequestCard(model: model, record: record)
                        }
                    }
                    .frame(maxWidth: 660)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                }
                .frame(maxHeight: 300)
            }
            AgentComposer(model: model, session: session, pending: $pending, guides: $guides) { next in onKeyChange(next) }
        }
        #if os(macOS)
        return HStack(spacing: 0) {
            mainColumn
            if inspectorOpen {
                Divider()
                AgentWorkbenchInspector(model: model, session: session, tab: $inspectorTab, noteDraft: $noteDraft) {
                    inspectorOpen = false
                }
                .frame(width: 288)
                .background(Theme.background.opacity(0.6))
            }
        }
        #else
        return mainColumn.sheet(isPresented: $inspectorOpen) {
            AgentWorkbenchInspector(model: model, session: session, tab: $inspectorTab, noteDraft: $noteDraft) {
                inspectorOpen = false
            }
        }
        #endif
    }

    private func header(_ session: CliSession, attach: Bool, shown: AgentTab) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.displayTitle(for: session)).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Text([session.engine.label, CliSessions.projectLabel(session), session.gitBranch ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                let tone = CliSessions.tone(session)
                if tone != .waiting { CliChip(text: CliSessions.statusLabel(session), tone: tone) }
                actions(session)
            }
            if attach {
                PillTabs(items: [AgentTab.terminal, .chat], title: { $0 == .terminal ? "终端" : "对话" }, selection: $tab)
                    .frame(maxWidth: 180)
            }
        }
        .padding(14)
    }

    @ViewBuilder
    private func actions(_ session: CliSession) -> some View {
        let canFork = !workspace.bots.isEmpty
        #if os(macOS)
        Button {
            if inspectorOpen && inspectorTab == .git { inspectorOpen = false } else { inspectorTab = .git; inspectorOpen = true }
        } label: {
            Image(systemName: "sidebar.right")
                .foregroundStyle(inspectorOpen ? Theme.nexAgentAccent : Theme.muted)
        }
        .buttonStyle(.bordered)
        .help(inspectorOpen ? "收起工作区面板" : "打开 Git / 笔记 / 侧聊面板")
        if canFork { Button("交给助手") { forking = true }.buttonStyle(.bordered) }
        #else
        Button { inspectorOpen = true } label: { Image(systemName: "info.circle") }
        if canFork {
            Menu {
                Button("交给助手") { forking = true }
            } label: { Image(systemName: "ellipsis.circle") }
        }
        #endif
    }

    /// What the records already held when the screen opened is history; a failure arriving later opens the alert.
    private func noteFailures(_ items: [CliItem]) {
        let failures = items.compactMap { item -> (id: String, ts: Int, reason: String)? in
            guard item.kind == .notice, item.level == .error, let reason = CliTranscript.modelFailureReason(item.text) else { return nil }
            return (item.id, item.ts, reason)
        }
        if failuresSeen == nil {
            guard !items.isEmpty else { return }
            let opened = Int(openedAt.timeIntervalSince1970 * 1000) - 5_000
            failuresSeen = Set(failures.filter { $0.ts < opened }.map(\.id))
        }
        let fresh = failures.filter { !(failuresSeen?.contains($0.id) ?? false) }
        for entry in fresh { failuresSeen?.insert(entry.id) }
        if let last = fresh.last { failure = last.reason }
    }
}

// MARK: Terminal

private struct AgentTerminalPane: View {
    let model: CliAgentsModel
    let key: CliSessionKey
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(CliTerminalPrefKeys.theme) private var themeRaw = CliTermThemeID.ink.rawValue
    @AppStorage(CliTerminalPrefKeys.fontSize) private var fontSize = CliTerminalPrefKeys.defaultFontSize
    @AppStorage(CliTerminalPrefKeys.cursorStyle) private var cursorStyleRaw = CliTermCursorStyle.block.rawValue
    @AppStorage(CliTerminalPrefKeys.cursorBlink) private var cursorBlink = true
    @AppStorage(CliTerminalPrefKeys.keyBar) private var showKeyBar = CliTerminalPrefKeys.defaultKeyBar
    @AppStorage(CliTerminalPrefKeys.optionAsMeta) private var optionAsMeta = true
    @AppStorage(CliTerminalPrefKeys.shortcuts) private var shortcutsJSON = ""

    @State private var controller: CliTerminalController?
    @State private var actions = CliTerminalActions()
    @State private var mods = CliTermModifiers()
    @State private var showSettings = false
    @State private var pickingFile = false
    @State private var uploadingText: String?
    @State private var dropping = false
    @State private var pendingPaste: String?
    @State private var toastText: String?
    @State private var toastError = false
    @State private var toastTask: Task<Void, Never>?

    private var style: CliTerminalStyle {
        CliTerminalStyle(
            theme: CliTermThemeID.named(themeRaw),
            fontSize: CGFloat(fontSize),
            cursorStyle: CliTermCursorStyle.named(cursorStyleRaw),
            cursorBlink: cursorBlink,
            optionAsMeta: optionAsMeta,
            dark: colorScheme == .dark
        )
    }

    var body: some View {
        let palette = style.palette
        VStack(spacing: 0) {
            if let controller {
                toolbar(controller)
                GeometryReader { proxy in
                    #if os(macOS)
                    CliTerminalView(
                        controller: controller,
                        actions: actions,
                        width: proxy.size.width,
                        control: controller.wantsControl,
                        style: style,
                        transformInput: transformInput
                    )
                    .id(ObjectIdentifier(controller))
                    .padding(6)
                    #else
                    CliTerminalView(
                        controller: controller,
                        actions: actions,
                        width: proxy.size.width,
                        control: controller.wantsControl,
                        style: style,
                        transformInput: transformInput,
                        onPinchFontSize: { next in fontSize = Double(next) }
                    )
                    .id(ObjectIdentifier(controller))
                    .padding(6)
                    #endif
                }
                .opacity(isStale(controller.status) ? 0.52 : 1)
                .saturation(isStale(controller.status) ? 0.45 : 1)
                .animation(.easeOut(duration: 0.2), value: controller.status)
                .overlay(alignment: .top) {
                    VStack(spacing: 6) {
                        banners(controller)
                    }
                    .padding(8)
                }
                .overlay(alignment: .bottom) {
                    if let toastText {
                        Text(toastText)
                            .font(.caption)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(toastError ? Theme.danger.opacity(0.95) : SwiftUI.Color.black.opacity(0.84), in: Capsule())
                            .padding(.bottom, 12)
                            .transition(.opacity)
                            .allowsHitTesting(false)
                    }
                }
                .background(SwiftUI.Color(hex: palette.background))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(dropping ? Theme.nexAgentAccent : (palette.isDark ? SwiftUI.Color.white.opacity(0.08) : Theme.border), lineWidth: dropping ? 2 : 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .padding(.horizontal, 14)
                .padding(.bottom, showKeyBar ? 6 : 8)
                #if os(macOS)
                .onDrop(of: [.fileURL], isTargeted: $dropping) { providers in
                    handleFileDrop(providers, controller: controller)
                }
                #endif

                if showKeyBar {
                    CliTerminalKeyBar(
                        mods: $mods,
                        disabled: controller.status != .controlling,
                        isDark: palette.isDark,
                        shortcuts: CliTermShortcuts.decode(shortcutsJSON),
                        onSendKey: { keyName in controller.sendKey(keyName, appCursor: actions.isAppCursor) },
                        onSendBare: { keyName in controller.sendKey(keyName, appCursor: actions.isAppCursor) },
                        onTypeCommand: { text, run in controller.sendText(run ? text + "\r" : text) },
                        onCopy: {
                            if actions.copySelection() { showToast("已复制到剪贴板") }
                            else { showToast("请先选中终端文本", error: true) }
                        },
                        onPaste: { pasteClipboard(controller) },
                        onPickFile: { pickingFile = true },
                        onOpenSettings: { showSettings = true },
                        onToggleKeyboard: { actions.toggleKeyboard() }
                    )
                    .padding(.horizontal, 14).padding(.bottom, 8)
                }
            } else {
                Text("正在连接").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { create() }
        .onChange(of: model.connected) { _, _ in create() }
        .onChange(of: model.streamRevision) { _, _ in recreate() }
        .onDisappear {
            toastTask?.cancel()
            controller?.stop()
            model.attach(nil)
            controller = nil
        }
        .sheet(isPresented: $showSettings) {
            CliTerminalSettingsView()
        }
        .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard let controller else { return }
            switch result {
            case .failure(let cause):
                showToast(cause.localizedDescription, error: true)
            case .success(let urls):
                Task { await uploadURLs(urls, controller: controller) }
            }
        }
        .alert("粘贴多行内容？", isPresented: Binding(get: { pendingPaste != nil }, set: { if !$0 { pendingPaste = nil } })) {
            Button("取消", role: .cancel) { pendingPaste = nil }
            Button("粘贴") {
                if let text = pendingPaste, let controller {
                    controller.sendInput(CliTermPaste.pasteData(text))
                }
                pendingPaste = nil
            }
        } message: {
            if let text = pendingPaste {
                Text("即将粘贴 \(CliTermPaste.lineCount(text)) 行内容到终端。")
            }
        }
    }

    private func create() {
        guard controller == nil, let made = model.makeTerminal(key: key, mode: .control) else { return }
        controller = made
        model.attach(made)
    }

    private func recreate() {
        let previousMode: CliTermMode = controller?.wantsControl == false ? .observe : .control
        controller?.stop()
        model.attach(nil)
        controller = nil
        guard let made = model.makeTerminal(key: key, mode: previousMode) else { return }
        controller = made
        model.attach(made)
    }

    private func isStale(_ status: CliTermStatus) -> Bool {
        status == .reconnecting || status == .closed
    }

    private func statusColor(_ status: CliTermStatus) -> SwiftUI.Color {
        switch status {
        case .controlling: Theme.success
        case .observing: Theme.brand
        case .connecting, .reconnecting: Theme.approval
        case .closed: Theme.danger
        }
    }

    private func toolbar(_ controller: CliTerminalController) -> some View {
        let mode = Binding<CliTermMode>(get: { controller.wantsControl ? .control : .observe }, set: { controller.setMode($0) })
        let status = controller.status
        let dims = controller.state.cols > 0 && controller.state.rows > 0 ? "\(controller.state.cols)×\(controller.state.rows)" : ""
        return HStack(spacing: 8) {
            PillTabs(items: [CliTermMode.control, .observe], title: { $0 == .control ? "控制" : "只看" }, selection: mode)
                .frame(maxWidth: 120)

            HStack(spacing: 5) {
                Circle().fill(statusColor(status)).frame(width: 7, height: 7)
                Text(status.text).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                if !dims.isEmpty {
                    Text(dims).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted.opacity(0.85)).lineLimit(1)
                }
            }

            Spacer(minLength: 4)

            HStack(spacing: 4) {
                toolbarIcon("keyboard", label: showKeyBar ? "隐藏快捷键栏" : "显示快捷键栏", active: showKeyBar) {
                    showKeyBar.toggle()
                }
                toolbarIcon("slider.horizontal.3", label: "终端设置", active: showSettings) {
                    showSettings = true
                }
                toolbarIcon("arrow.clockwise", label: "重新连接", active: false) {
                    controller.reconnect()
                }
            }
        }
        .padding(.horizontal, 14).padding(.bottom, 8)
    }

    private func toolbarIcon(_ symbol: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(active ? Theme.nexAgentAccent : Theme.muted)
                .frame(width: 28, height: 28)
                .background(active ? Theme.nexAgentSoft : SwiftUI.Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func banners(_ controller: CliTerminalController) -> some View {
        let status = controller.status
        if status == .reconnecting {
            bannerRow("正在重新连接…", tone: .warn, button: "立即重试") { controller.reconnect() }
        }
        if status == .closed {
            let reason = controller.state.errorCode.flatMap { CliErrorText.byCode[$0] } ?? CliTermState.closeReasonText(controller.state.reason)
            bannerRow(reason.isEmpty ? "终端已断开" : reason, tone: .danger, button: "重新连接") { controller.reconnect() }
        }
        if status == .observing && controller.controlDeclined {
            bannerRow("暂未取得终端控制权", tone: .warn, button: "重新接管") { controller.reconnect(mode: .control) }
        }
        if let uploadingText {
            bannerRow(uploadingText, tone: .info, button: nil, action: nil)
        }
    }

    private enum BannerTone { case info, warn, danger }

    private func bannerRow(_ text: String, tone: BannerTone, button: String?, action: (() -> Void)?) -> some View {
        HStack(spacing: 8) {
            Text(text)
                .font(.caption)
                .foregroundStyle(tone == .danger ? Theme.danger : Theme.foreground)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let button, let action {
                Button(button, action: action)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(Theme.nexAgentSolid, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(tone == .danger ? Theme.danger.opacity(0.45) : tone == .warn ? Theme.approval.opacity(0.45) : Theme.border)
        )
        .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
    }

    private func transformInput(_ raw: Data, _ appCursor: Bool) -> Data {
        guard mods.active else { return raw }
        if let keyName = CliTermKeyEncoder.keyName(for: raw),
           let encoded = CliTermKeyEncoder.encode(mods.apply(keyName), appCursor: appCursor) {
            mods.pressed()
            return encoded
        }
        if let str = String(data: raw, encoding: .utf8), str.count == 1, let ch = str.first {
            let mapped = mods.typed(ch)
            mods.pressed()
            if let key = mapped.key, let encoded = CliTermKeyEncoder.encode(key, appCursor: appCursor) { return encoded }
            if let text = mapped.text { return Data(text.utf8) }
        }
        return raw
    }

    private func pasteClipboard(_ controller: CliTerminalController) {
        guard controller.status == .controlling else {
            showToast("请先切换到控制模式", error: true)
            return
        }
        #if os(macOS)
        let pb = NSPasteboard.general
        if let text = pb.string(forType: .string), !text.isEmpty {
            submitPaste(text, controller: controller)
            return
        }
        if let png = pb.data(forType: .png) {
            Task { await uploadData([(name: "image.png", data: png)], controller: controller) }
            return
        }
        if let tiff = pb.data(forType: .tiff),
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            Task { await uploadData([(name: "image.png", data: png)], controller: controller) }
            return
        }
        #else
        if let text = UIPasteboard.general.string, !text.isEmpty {
            submitPaste(text, controller: controller)
            return
        }
        if let img = UIPasteboard.general.image?.pngData() {
            Task { await uploadData([(name: "image.png", data: img)], controller: controller) }
            return
        }
        #endif
        showToast("剪贴板为空", error: true)
    }

    private func submitPaste(_ text: String, controller: CliTerminalController) {
        if CliTermPaste.lineCount(text) > 1 {
            pendingPaste = text
        } else {
            controller.sendInput(CliTermPaste.pasteData(text))
        }
    }

    #if os(macOS)
    private func handleFileDrop(_ providers: [NSItemProvider], controller: CliTerminalController) -> Bool {
        let matching = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !matching.isEmpty else { return false }
        let expected = matching.count
        let (stream, continuation) = AsyncStream<URL?>.makeStream()
        for provider in matching {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) {
                    continuation.yield(url)
                } else if let url = item as? URL {
                    continuation.yield(url)
                } else {
                    continuation.yield(nil)
                }
            }
        }
        Task { @MainActor in
            var urls: [URL] = []
            var seen = 0
            for await url in stream {
                if let url { urls.append(url) }
                seen += 1
                if seen >= expected { break }
            }
            continuation.finish()
            if !urls.isEmpty { await uploadURLs(urls, controller: controller) }
        }
        return true
    }
    #endif

    private func uploadURLs(_ urls: [URL], controller: CliTerminalController) async {
        var files: [(name: String, data: Data)] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey]) {
                if values.isDirectory == true {
                    showToast("不支持直接上传文件夹", error: true)
                    continue
                }
                if let size = values.fileSize, size > CoreClient.cliMaxAttachBytes {
                    showToast("附件不能超过 8 MB", error: true)
                    continue
                }
            }
            guard let data = try? Data(contentsOf: url, options: .mappedIfSafe), !data.isEmpty else {
                showToast("无法读取文件 \(url.lastPathComponent)", error: true)
                continue
            }
            files.append((name: url.lastPathComponent, data: data))
        }
        if !files.isEmpty { await uploadData(files, controller: controller) }
    }

    private func uploadData(_ files: [(name: String, data: Data)], controller: CliTerminalController) async {
        guard controller.status == .controlling else {
            showToast("请先切换到控制模式再上传文件", error: true)
            return
        }
        uploadingText = files.count == 1 ? "正在上传 \(files[0].name)…" : "正在上传 \(files[0].name) 等 \(files.count) 个文件…"
        defer { uploadingText = nil }
        var paths: [String] = []
        for file in files {
            do {
                let remotePath = try await model.attachTerminalFile(key, name: file.name, data: file.data)
                paths.append(remotePath)
            } catch {
                showToast("\(file.name) 上传失败：\(CliErrorText.text(for: error))", error: true)
            }
        }
        guard !paths.isEmpty else { return }
        guard controller.status == .controlling else {
            showToast("终端控制已结束，文件未填入", error: true)
            return
        }
        controller.sendInput(CliTermPaste.pasteData(CliTermPaste.pastedPaths(paths)))
    }

    private func showToast(_ text: String, error: Bool = false) {
        toastTask?.cancel()
        toastText = text
        toastError = error
        toastTask = Task {
            try? await Task.sleep(for: .seconds(2.4))
            guard !Task.isCancelled else { return }
            toastText = nil
        }
    }
}

// MARK: Transcript

private struct AgentGuide {
    let key: CliSessionKey
    let id: String
    let text: String
    let at: Int
    let known: Set<String>
    let after: String?
    let tail: CliItem?
    var uncertain = false

    static func timeline(_ items: [CliItem], _ guides: [Self]) -> [CliItem] {
        guard let first = guides.first else { return items }
        var echoes = Set<String>()
        var rows: [(item: CliItem, rank: Int)] = []
        for (index, guide) in guides.enumerated() {
            let boundary = guide.after.flatMap { id in items.firstIndex { $0.id == id } } ?? -1
            let echo = items.dropFirst(boundary + 1).first { $0.kind == .user && $0.text == guide.text && !guide.known.contains($0.id) && !echoes.contains($0.id) }
            if let echo { echoes.insert(echo.id) }
            var row = echo ?? CliItem(id: "guide:" + guide.id, ts: guide.at, kind: .user, text: guide.text)
            row.ts = guide.at
            row.queued = false
            rows.append((row, 2 * index + 1))
        }
        for item in items where !echoes.contains(item.id) {
            var rank = 2 * (guides.firstIndex { $0.known.contains(item.id) } ?? guides.count)
            guard item.kind == .assistant else { rows.append((item, rank)); continue }
            var part = item
            var offset = item.text.startIndex
            var startAt = Int.min
            for (index, guide) in guides.enumerated() {
                guard let tail = guide.tail, tail.id == item.id, item.text.hasPrefix(tail.text) else { continue }
                let cut = item.text.index(item.text.startIndex, offsetBy: tail.text.count)
                guard cut >= offset else { continue }
                if cut > offset {
                    part.ts = min(guide.at, max(startAt, tail.ts))
                    part.text = String(item.text[offset..<cut])
                    rows.append((part, rank))
                }
                offset = cut
                part.id = "after-guide:" + guide.id
                startAt = guide.at
                part.ts = max(item.ts, guide.at)
                rank = 2 * index + 2
            }
            if offset < item.text.endIndex {
                part.text = String(item.text[offset...])
                rows.append((part, rank))
            }
        }
        var before: [CliItem] = []
        var after: [(item: CliItem, rank: Int)] = []
        for row in rows {
            if row.item.ts < first.at || first.known.contains(row.item.id) { before.append(row.item) }
            else { after.append(row) }
        }
        return before + after.sorted { ($0.item.ts, $0.rank) < ($1.item.ts, $1.rank) }.map(\.item)
    }
}

private struct AgentTranscript: View {
    let model: CliAgentsModel
    let key: CliSessionKey
    @Binding var expandedActivities: Set<String>
    var guides: [AgentGuide] = []
    var engine: CliEngine = .claude
    var active = false
    /// what the agent is doing while the turn runs; shown as dots under the last message
    var working: String?
    /// messages sent from here that the records do not hold yet
    var pending: [AgentPendingSend] = []
    var branch: ((String) -> Void)?
    var onNote: ((CliItem) -> Void)?
    @State private var lateReceipt: String?

    var body: some View {
        let t = model.transcript(key)
        let sent = pending.filter { $0.waiting(in: t.items) }
        let echo = t.items.contains { $0.kind == .user } ? nil : model.echoes[key]
        let receipt = model.sessions.first { $0.key == key }
        let codexPending = engine == .codex && receipt?.online == true && (receipt?.state == .idle || receipt?.state == .stopped) && (echo != nil || !sent.isEmpty)
        let nativeQueued = sent.last?.nativeQueued ?? echo?.nativeQueued ?? false
        let receiptID = codexPending && !nativeQueued ? (sent.last?.id.uuidString ?? key) : nil
        let delivery = sent.contains(where: \.uploading) ? "正在上传附件" : codexPending ? (nativeQueued ? "Codex 已接收，等待开始" : lateReceipt == receiptID ? "Codex 尚未确认收件，请查看终端" : "等待 Codex 确认收件") : nil
        let working = delivery == nil ? (self.working ?? (sent.isEmpty && echo == nil ? nil : "等待回复")) : nil
        let timeline = AgentGuide.timeline(t.items, guides)
        let blocks = CliTranscript.group(timeline)
        let rows = CliTranscript.rows(timeline, active: active)
        let completed = CliTranscript.completedReplies(t.items, active: active)
        // copy and branch: only on a finished reply's conclusion
        let conclusions = CliTranscript.replyTails(blocks).intersection(completed)
        Group {
            if blocks.isEmpty && (echo != nil || !sent.isEmpty) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let echo { AgentEchoBubble(text: echo.text, loadImage: model.downloadImage) }
                        ForEach(sent) { AgentEchoBubble(text: $0.text, loadImage: model.downloadImage) }
                        if let delivery { Text(delivery).font(.caption).foregroundStyle(Theme.muted) }
                        if let working { AgentWorkingRow(engine: engine, label: working, byline: true) }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 6)
                }
            } else if let error = t.error, t.items.isEmpty {
                VStack(spacing: 8) {
                    Text(error).font(.footnote).foregroundStyle(Theme.danger)
                    Button("重试") { model.reloadTranscript(key) }.buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !t.loaded {
                Text("正在读取…").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if blocks.isEmpty {
                Text("暂无记录").font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if t.more {
                                Button(t.loadingOlder ? "正在读取…" : t.olderError == nil ? "加载更早的记录" : "重试加载更早的记录") { Task { await model.loadOlder(key) } }
                                    .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.nexAgentAccent).disabled(t.loadingOlder)
                                    .frame(maxWidth: .infinity)
                                    // reading upwards loads earlier records without a tap
                                    .onAppear { if t.olderError == nil { Task { await model.loadOlder(key) } } }
                                if let error = t.olderError {
                                    Text(error).font(.caption).foregroundStyle(Theme.danger)
                                        .frame(maxWidth: .infinity)
                                }
                            }
                            ForEach(displayRows(from: rows)) { entry in
                                if entry.byline || entry.progress != nil {
                                    VStack(alignment: .leading, spacing: 6) {
                                        if entry.byline { AgentByline(engine: engine) }
                                        if let progress = entry.progress {
                                            MoreContent(durationMs: progress.durationMs) {
                                                ForEach(progress.blocks) { block in rendered(block, conclusions: [], completed: [], translate: false) }
                                            }
                                        }
                                        if let block = entry.block {
                                            rendered(block, conclusions: conclusions, completed: completed, translate: t.translationEnabled)
                                        }
                                    }
                                } else if let block = entry.block {
                                    rendered(block, conclusions: conclusions, completed: completed, translate: t.translationEnabled)
                                }
                            }
                            if let echo { AgentEchoBubble(text: echo.text, loadImage: model.downloadImage) }
                            ForEach(sent) { AgentEchoBubble(text: $0.text, loadImage: model.downloadImage) }
                            if let delivery { Text(delivery).font(.caption).foregroundStyle(Theme.muted) }
                            // the agent's name heads the dots only when nothing of this reply is shown yet
                            if let working { AgentWorkingRow(engine: engine, label: working, byline: echo != nil || !sent.isEmpty || { if case .user = blocks.last { return true } else { return false } }()) }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(.horizontal, 14).padding(.vertical, 6)
                    }
                    .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
                    .onChange(of: blocks.last?.id) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                    .onChange(of: working) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                    .onChange(of: sent.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                    .onChange(of: t.items.last?.text.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
        }
        .task(id: receiptID) {
            lateReceipt = nil
            guard let receiptID else { return }
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            lateReceipt = receiptID
        }
    }
    private struct DisplayRow: Identifiable {
        let id: String
        let byline: Bool
        let progress: (id: String, blocks: [CliBlock], durationMs: Int?)?
        let block: CliBlock?
    }

    private func displayRows(from rows: [CliTranscriptRow]) -> [DisplayRow] {
        var heads: Set<String> = []
        var replying = false
        for row in rows {
            guard case .block(let block) = row else { continue }
            switch block {
            case .user: replying = false
            case .assistant where !replying:
                heads.insert(block.id)
                replying = true
            default: break
            }
        }
        var out: [DisplayRow] = []
        var seenAssistant = false
        for (index, row) in rows.enumerated() {
            switch row {
            case .progress(let id, let parts, let durationMs):
                guard !parts.isEmpty else { continue }
                if index + 1 < rows.count, case .block(let next) = rows[index + 1], case .assistant = next, heads.contains(next.id) {
                    continue
                }
                let showByline = !seenAssistant
                seenAssistant = true
                out.append(DisplayRow(id: id, byline: showByline, progress: (id, parts, durationMs), block: nil))
            case .block(let block):
                if case .user = block { seenAssistant = false }
                var attached: (id: String, blocks: [CliBlock], durationMs: Int?)?
                let showByline: Bool
                if case .assistant = block, heads.contains(block.id) {
                    showByline = true
                    if index > 0, case .progress(let pid, let parts, let durationMs) = rows[index - 1], !parts.isEmpty {
                        attached = (pid, parts, durationMs)
                    }
                    seenAssistant = true
                } else {
                    showByline = false
                }
                out.append(DisplayRow(id: block.id, byline: showByline, progress: attached, block: block))
            }
        }
        return out
    }

    private func rendered(_ block: CliBlock, conclusions: Set<String>, completed: Set<String>, translate: Bool) -> some View {
        let guide = guides.first { "guide:" + $0.id == block.id }
        let state = guide.flatMap { guide in model.queues[key]?.entries.first { $0.id == guide.id }?.status }
        return AgentBlockView(block: block, guideStatus: state == "failed" ? "发送失败" : (state == "uncertain" || guide?.uncertain == true ? "待确认" : nil), expandedActivities: $expandedActivities, loadImage: model.downloadImage, translate: translate && completed.contains(block.id) && !guides.contains(where: { $0.tail?.id == block.id }) ? { item in
        try await model.translateReply(key, item: item)
        } : nil, actions: conclusions.contains(block.id), branch: conclusions.contains(block.id) ? branch : nil, onNote: conclusions.contains(block.id) ? onNote : nil)
    }

}

private struct AgentBlockView: View {
    let block: CliBlock
    var guideStatus: String? = nil
    @Binding var expandedActivities: Set<String>
    let loadImage: (String) async throws -> Data
    var translate: ((CliItem) async throws -> String?)?
    var actions = true
    var branch: ((String) -> Void)?
    var onNote: ((CliItem) -> Void)?

    var body: some View {
        switch block {
        case .user(let item):
            HStack {
                Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 2) {
                    AgentImageMessage(text: ([item.text] + item.images.filter { $0.hasPrefix("/api/cli-agents/images/") && !item.text.contains($0) }).joined(separator: "\n"), load: loadImage)
                    if let guideStatus { Text(guideStatus).font(.caption2).foregroundStyle(Theme.muted) }
                    if item.queued { Text("排队中").font(.caption2).foregroundStyle(Theme.muted) }
                }
            }
        case .assistant(let item):
            AgentReplyText(item: item, load: loadImage, translate: translate, actions: actions, branch: branch, onNote: onNote)
        case .activity(let id, let items):
            AgentActivity(items: items, open: Binding(get: { expandedActivities.contains(id) }, set: { open in
                if open { expandedActivities.insert(id) }
                else { expandedActivities.remove(id) }
            }))
        case .notice(_, let level, let text):
            Text(text).font(.caption).foregroundStyle(level == .error ? Theme.danger : Theme.muted).frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

private struct AgentReplyText: View {
    let item: CliItem
    let load: (String) async throws -> Data
    var translate: ((CliItem) async throws -> String?)?
    var actions = true
    var branch: ((String) -> Void)?
    var onNote: ((CliItem) -> Void)?
    @State private var translated: String?
    @State private var original = false
    @State private var failed = false
    @State private var retry = 0
    private var displayedText: String { original ? item.text : translated ?? item.text }

    private struct Request: Equatable {
        let source: String
        let attempt: Int
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AgentImageMessage(text: displayedText, markdown: true, load: load)
                .frame(maxWidth: .infinity, alignment: .leading)
            if translated != nil {
                Button(original ? "查看中文" : "查看原文") { original.toggle() }
                    .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.nexAgentAccent)
            } else if failed {
                Button("重试翻译") { retry += 1 }
                    .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.nexAgentAccent)
            }
            if actions {
                HStack(spacing: 4) {
                    Button {
                        #if os(macOS)
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(displayedText, forType: .string)
                        #else
                        UIPasteboard.general.string = displayedText
                        #endif
                    } label: { Label("复制", systemImage: "doc.on.doc") }
                        .help("复制")
                    if let branch {
                        Button { branch(item.id) } label: { Label("分支到新聊天", systemImage: "arrow.triangle.branch") }
                            .help("分支到新聊天")
                    }
                    if let onNote {
                        Button { onNote(item) } label: { Label("记笔记", systemImage: "note.text.badge.plus") }
                            .help("添加到会话笔记")
                    }
                }
                .labelStyle(.iconOnly).buttonStyle(.borderless).font(.system(size: 13)).foregroundStyle(Theme.muted)
            }
        }
        .task(id: translate == nil ? nil : Request(source: item.text, attempt: retry)) {
            translated = nil
            failed = false
            guard let translate, item.text.range(of: "[A-Za-z]{3,}", options: .regularExpression) != nil else { return }
            do {
                let result = try await translate(item)
                if !Task.isCancelled { translated = result }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }
}

private enum AgentToolKind {
    case shell, read, edit, search, message, think, other

    static func classify(_ name: String) -> Self {
        let lower = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower == "agentmessage" || lower == "agent_message" { return .message }
        if lower.contains("bash") || lower.contains("shell") || lower.contains("exec") || lower.contains("terminal") || lower.contains("command") { return .shell }
        if lower.contains("edit") || lower.contains("write") || lower.contains("patch") || lower.contains("replace") || lower.contains("create") { return .edit }
        if lower.contains("read") || lower.contains("view") || lower.contains("cat") || lower == "ls" || lower.contains("list") { return .read }
        if lower.contains("grep") || lower.contains("glob") || lower.contains("search") || lower.contains("find") || lower.contains("web") || lower.contains("fetch") { return .search }
        return .other
    }

    var symbol: String {
        switch self {
        case .shell: "terminal"
        case .read: "doc.text"
        case .edit: "pencil.line"
        case .search: "magnifyingglass"
        case .message: "bubble.left"
        case .think: "brain"
        case .other: "wrench"
        }
    }

    var pastLabel: String {
        switch self {
        case .shell: "运行了命令"
        case .read: "读取了文件"
        case .edit: "修改了文件"
        case .search: "搜索了内容"
        case .message: "收到协作者消息"
        case .think: "思考了片刻"
        case .other: "执行了工具"
        }
    }

    var requestVerb: String {
        switch self {
        case .shell: "请求执行"
        case .edit: "修改文件"
        case .read: "读取文件"
        default: "请求操作"
        }
    }

    var cardHeader: String {
        switch self {
        case .shell: "Shell"
        case .read: "Read"
        case .edit: "Edit"
        case .search: "Search"
        case .message: "协作者消息"
        case .think: "Thinking"
        case .other: "Tool"
        }
    }
}

private struct AgentActivity: View {
    let items: [CliItem]
    @Binding var open: Bool

    private var summary: (symbol: String, text: String, failed: Int) {
        let tools = items.filter { $0.kind == .tool }
        let failed = tools.filter { $0.status == .error }.count
        if tools.isEmpty { return (AgentToolKind.think.symbol, "思考了片刻", 0) }
        let kinds = tools.map { AgentToolKind.classify($0.name) }
        let unique = Set(kinds)
        if tools.count == 1, let only = kinds.first { return (only.symbol, only.pastLabel, failed) }
        if unique.count == 1, let only = unique.first { return (only.symbol, "\(only.pastLabel) · \(tools.count) 项", failed) }
        return (kinds.first?.symbol ?? "wrench", "执行了 \(tools.count) 项操作", failed)
    }

    var body: some View {
        let info = summary
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.easeOut(duration: 0.16)) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: info.symbol).font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                    Text(info.text).font(.system(size: 12.5)).foregroundStyle(Theme.muted)
                    if info.failed > 0 {
                        Text("· \(info.failed) 项失败").font(.system(size: 11.5)).foregroundStyle(Theme.danger)
                    }
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted.opacity(0.7))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.vertical, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(items) { item in
                        if item.kind == .tool {
                            AgentToolRow(item: item)
                        } else {
                            Text(item.text).font(.caption).foregroundStyle(Theme.muted).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 2)
                        }
                    }
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Theme.border).frame(width: 1).padding(.vertical, 2)
                }
                .padding(.leading, 5)
                .frame(maxWidth: 640, alignment: .leading)
            }
        }
    }
}

private struct AgentToolRow: View {
    let item: CliItem
    @State private var open = false

    private var kind: AgentToolKind { AgentToolKind.classify(item.name) }

    var body: some View {
        let isMessage = kind == .message
        let sender = item.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "协作者" : item.input
        let backgroundTitle = isMessage ? nil : CliTranscript.backgroundTaskTitle(item)
        let lineText: String = {
            if isMessage {
                let preview = CliTranscript.toolSummary(item.output ?? "")
                return preview.isEmpty ? sender : "\(sender) · \(preview)"
            }
            if let backgroundTitle { return backgroundTitle }
            let s = CliTranscript.toolSummary(item.input)
            return s.isEmpty ? item.name : s
        }()
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: kind.symbol).font(.system(size: 11))
                        .foregroundStyle(item.status == .error ? Theme.danger : Theme.muted)
                    Text(lineText).font(isMessage ? .system(size: 12) : .system(size: 12, design: .monospaced))
                        .foregroundStyle(open ? Theme.foreground : Theme.muted)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.muted.opacity(0.65))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                VStack(alignment: .leading, spacing: 0) {
                    Text(isMessage ? "来自 \(sender)" : kind.cardHeader).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                    Divider().opacity(0.5)
                    if isMessage {
                        if let output = item.output, !output.isEmpty {
                            Text(output).font(.system(size: 12.5)).foregroundStyle(Theme.foreground)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 10).padding(.vertical, 8)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            if !item.input.isEmpty {
                                ToolCodeBlock(text: kind == .shell ? "$ " + item.input : item.input)
                                    .foregroundStyle(Theme.foreground)
                            }
                            if let output = item.output, !output.isEmpty {
                                ToolCodeBlock(text: output)
                                    .foregroundStyle(Theme.muted)
                            }
                        }
                        Divider().opacity(0.5)
                        HStack(spacing: 4) {
                            Spacer()
                            Image(systemName: item.status == .error ? "xmark" : item.status == .running ? "clock" : "checkmark")
                                .font(.system(size: 10, weight: .semibold))
                            Text(item.status == .error ? "失败" : item.status == .running ? "运行中" : "成功")
                                .font(.system(size: 11))
                        }
                        .foregroundStyle(item.status == .error ? Theme.danger : item.status == .running ? Theme.nexAgentAccent : Theme.muted)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                    }
                }
                .background(Theme.wash, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
            }
        }
    }
}

// MARK: Requests — Scheme E Floating Glass Island

struct AgentRequestCard: View {
    let model: CliAgentsModel
    let record: CliRequestRecord
    @State private var selection: CliRequestStore.Selection = [:]
    @State private var other: CliRequestStore.OtherAnswers = [:]
    @State private var busy: CliDecision?
    @State private var busyAlways = false
    @State private var error = ""

    private static let optionLetters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    private var request: CliRequest { record.view }

    var body: some View {
        let state = model.cardState(record)
        let open = state == .pending
        if !open {
            resolvedPill(state)
        } else if request.kind == .question {
            questionIsland
        } else {
            permissionIsland
        }
    }

    private func resolvedPill(_ state: CliCardState) -> some View {
        let dotColor: Color = switch state {
        case .denied: Theme.danger
        case .allowed, .always, .answered: Theme.nexAgentAccent
        default: Theme.muted
        }
        let label = request.kind == .question
            ? (request.questions?.map(\.question).joined(separator: " / ") ?? (request.summary.isEmpty ? "提问" : request.summary))
            : request.tool
        return HStack(spacing: 7) {
            Circle().fill(dotColor).frame(width: 7, height: 7)
            Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.foreground).lineLimit(1)
            Text("· \(state.text)").font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .glass(Capsule(), strong: true, lift: .none)
    }

    private var permissionIsland: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(request.tool).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.nexAgentAccent)
                        Text("· \(AgentToolKind.classify(request.tool).requestVerb)").font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                    }
                    if !request.summary.isEmpty {
                        Text(request.summary)
                            .font(.system(size: 12.5, design: .monospaced))
                            .foregroundStyle(Theme.foreground)
                            .lineLimit(2)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 3) {
                    islandButton(busy == .deny ? "拒绝中…" : "拒绝", role: .deny) { submit(.deny) }
                    if request.offersAlways {
                        islandButton(busyAlways ? "处理中…" : "总是", role: .secondary) { submit(.allow, always: true) }
                            .help("本会话总是允许")
                            .accessibilityLabel("本会话总是允许")
                    }
                    islandButton(busy == .allow && !busyAlways ? "允许中…" : "允许", role: .primary) { submit(.allow) }
                }
                .padding(4)
                .background(Theme.wash, in: Capsule())
                .disabled(busy != nil)
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(Theme.danger) }
        }
        .padding(.leading, 16).padding(.trailing, 10).padding(.vertical, 10)
        .glass(RoundedRectangle(cornerRadius: 24, style: .continuous), strong: true, lift: .card)
    }

    private var questionIsland: some View {
        let questions = request.questions ?? []
        let multiQ = questions.count > 1
        let complete = CliRequestStore.answersComplete(questions, selection, other: other)
        return VStack(alignment: .leading, spacing: 12) {
            if !questions.isEmpty {
                ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                    if index > 0 { Divider().opacity(0.45) }
                    questionSection(index, question, multiQ: multiQ, total: questions.count)
                }
            } else if !request.summary.isEmpty {
                Text(request.summary).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Theme.foreground)
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(Theme.danger) }
            HStack {
                Spacer()
                HStack(spacing: 3) {
                    islandButton(busy == .deny ? "拒绝中…" : "拒绝", role: .deny) { submit(.deny) }
                    islandButton(busy == .allow ? "提交中…" : "提交", role: .primary, disabled: !complete) { submit(.allow) }
                        .disabled(!complete)
                }
                .padding(4)
                .background(Theme.wash, in: Capsule())
                .disabled(busy != nil)
            }
        }
        .padding(16)
        .glass(RoundedRectangle(cornerRadius: 24, style: .continuous), strong: true, lift: .card)
    }

    private func questionSection(_ index: Int, _ question: CliQuestion, multiQ: Bool, total: Int) -> some View {
        let chosen = selection[index] ?? []
        let otherOn = chosen.contains(CliRequestStore.otherChoice)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if multiQ {
                    Text("\(index + 1) / \(total)")
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Theme.nexAgentAccent)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.nexAgentSoft, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                } else if let header = question.header, !header.isEmpty {
                    Text(header)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.nexAgentAccent)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Theme.nexAgentSoft, in: Capsule())
                }
                Text(question.question).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.foreground)
                Spacer(minLength: 4)
                if question.multiSelect { Text("可多选").font(.caption2).foregroundStyle(Theme.muted) }
            }

            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(question.options.enumerated()), id: \.element.label) { optIndex, option in
                    let on = chosen.contains(option.label)
                    let letter = optIndex < Self.optionLetters.count ? String(Self.optionLetters[optIndex]) : "\(optIndex + 1)"
                    Button {
                        selection = CliRequestStore.toggle(selection, index: index, label: option.label, multi: question.multiSelect)
                    } label: {
                        HStack(alignment: .center, spacing: 10) {
                            optionBadge(selected: on, multi: question.multiSelect, marker: letter)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(option.label).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.foreground)
                                if let description = option.description, !description.isEmpty {
                                    Text(description).font(.caption).foregroundStyle(Theme.muted)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(on ? Theme.nexAgentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(on ? Theme.nexAgentAccent : Theme.border))
                        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(busy != nil)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        selection = CliRequestStore.toggle(selection, index: index, label: CliRequestStore.otherChoice, multi: question.multiSelect)
                    } label: {
                        HStack(spacing: 10) {
                            optionBadge(selected: otherOn, multi: question.multiSelect, marker: "…")
                            Text(question.multiSelect ? "其他补充" : "其他（自定义输入）")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.foreground)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(busy != nil)

                    if otherOn {
                        TextField(question.multiSelect ? "输入补充内容…" : "输入自定义回复…", text: otherBinding(index))
                            .textFieldStyle(.plain)
                            .font(.system(size: 13))
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                            .padding(.leading, question.multiSelect ? 27 : 34)
                            .disabled(busy != nil)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(otherOn ? Theme.nexAgentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(otherOn ? Theme.nexAgentAccent : Theme.border))
            }
        }
    }

    private func otherBinding(_ index: Int) -> Binding<String> {
        Binding(get: { other[index] ?? "" }, set: { other[index] = $0 })
    }

    @ViewBuilder
    private func optionBadge(selected: Bool, multi: Bool, marker: String) -> some View {
        if multi {
            ZStack {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(selected ? Theme.nexAgentSolid : Color.clear)
                    .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(selected ? Theme.nexAgentSolid : Theme.border, lineWidth: 1.5))
                if selected {
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.white)
                }
            }
            .frame(width: 17, height: 17)
        } else {
            ZStack {
                Circle().fill(selected ? Theme.nexAgentSolid : Theme.wash)
                Text(selected ? "✓" : marker)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(selected ? Color.white : Theme.muted)
            }
            .frame(width: 24, height: 24)
        }
    }

    private enum IslandRole { case deny, secondary, primary }

    private func islandButton(_ title: String, role: IslandRole, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: role == .primary ? .semibold : .medium))
                .foregroundStyle(role == .primary ? Color.white : role == .deny ? Theme.muted : Theme.foreground)
                .padding(.horizontal, role == .primary ? 15 : 11)
                .padding(.vertical, 6)
                .background(role == .primary ? Theme.nexAgentSolid : Color.clear, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .opacity(disabled ? 0.42 : 1)
    }

    private func submit(_ decision: CliDecision, always: Bool = false) {
        busy = decision; busyAlways = always; error = ""
        Task {
            do { try await model.answer(request, decision: decision, selection: selection, other: other, always: always) }
            catch { self.error = CliAgentsModel.answerErrorText(error) }
            busy = nil; busyAlways = false
        }
    }
}

// MARK: Composer

private struct AgentComposer: View {
    let model: CliAgentsModel
    let session: CliSession
    @Binding var pending: [AgentPendingSend]
    @Binding var guides: [AgentGuide]
    @State private var editing: CliQueuedEntry?
    @State private var editedText = ""
    let onKeyChange: (CliSessionKey) -> Void
    @State private var draft = ""
    @State private var sending = false
    @State private var error = ""
    @State private var deliveryNotice: String?
    @State private var images: [CliImageUpload] = []
    @State private var showingEffort = false
    @State private var effort: String?
    @State private var chosenModel = ""
    @State private var showingSkills = false
    @State private var showingModels = false
    @State private var catalog = CliModelCatalog(models: [])

    private var canSetOnResume: Bool { model.device(session.deviceId)?.cliAgents?.features.contains("launchOptions") == true }
    private var claudeInbox: Bool {
        session.engine == .claude && session.sendVia == "inbox" && model.device(session.deviceId)?.cliAgents?.features.contains("inboxSteer") == true
    }
    private var managedProtocol: Bool { (session.engine == .agy && session.sendVia == "acp") || (session.engine == .zcode && session.sendVia == "host" && session.liveIn == .background) }
    private var canConfigureProtocol: Bool { managedProtocol && session.state == .idle && canSetOnResume }
    private var pendingRequests: [CliRequestRecord] { model.cards(session.key).filter { model.cardState($0) == .pending } }
    private var steerQuestionId: String? {
        guard canSetOnSend, session.state == .running || session.state == .waiting else { return nil }
        let pending = pendingRequests
        guard pending.count == 1, let question = pending.first?.view,
              question.kind == .question, question.tool == "AskUserQuestion" else { return nil }
        return question.id
    }
    private var interruptWaiting: Bool { canSetOnSend && session.state == .waiting && pendingRequests.isEmpty }
    private var canSteer: Bool {
        guard session.online else { return false }
        if steerQuestionId != nil || interruptWaiting { return true }
        return pendingRequests.isEmpty && session.state == .running && ((session.liveIn == .nexbot && session.terminal != nil) || claudeInbox || managedProtocol)
    }
    private var steerLabel: String {
        if steerQuestionId != nil { return "取消提问并引导" }
        return interruptWaiting ? "中断并引导" : "引导"
    }
    private var composerMode: CliComposerMode {
        if claudeInbox && session.online && session.state != .stopped {
            return .send(running: session.state == .running || session.state == .waiting)
        }
        return CliSessions.composerMode(session)
    }
    private var canSetOnSend: Bool { session.engine == .claude && session.liveIn == .nexbot && session.terminal != nil }
    private var effortLevels: [String] { session.engine == .agy || session.engine == .zcode ? offered : CliLaunches.reasoningLevels }
    private var selectedEffort: String { CliLaunches.reasoningChoice(effort) }
    private var offered: [String] {
        let effectiveModel = chosenModel.isEmpty ? session.model ?? catalog.current ?? "" : chosenModel
        return CliLaunches.efforts(engine: session.engine, models: catalog.models, model: effectiveModel)
    }
    private var resolvedEffort: String? {
        CliLaunches.resolveEffort(engine: session.engine, offered: offered, preferred: selectedEffort)
    }
    @State private var permission: (mode: CliPermissionMode, pending: Bool)?
    /// A stopped session and an idle Antigravity / ZCode session take a new permission mode with the next message; a CLI
    /// running in a terminal has no way in, so it takes it the next time it starts (same as the web client).
    private var permissionChoice: AgentPermissionChoice? {
        let modes = CliPermissions.modes(engine: session.engine, features: model.device(session.deviceId)?.cliAgents?.features ?? [])
        guard !modes.isEmpty else { return nil }
        let takesNow = session.state == .stopped || managedProtocol
        return AgentPermissionChoice(engine: session.engine, modes: modes, value: permission?.mode,
                                     pending: permission?.pending == true ? (takesNow ? "发送下一条消息时生效" : "会话下次启动时生效") : nil) { mode in
            permission = (mode, true)
            AgentDrafts.permissions[session.key] = (mode, true)
        }
    }
    private var pendingPermission: CliPermissionMode? { permission?.pending == true ? permission?.mode : nil }
    private func tookPermission(_ key: CliSessionKey, _ mode: CliPermissionMode) {
        permission = (mode, false)
        AgentDrafts.permissions[key] = (mode, false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(Theme.danger) }
            if let queue = model.queues[session.key] { queueRows(queue) }
            if let deliveryNotice { Text(deliveryNotice).font(.caption).foregroundStyle(Theme.muted) }
            AgentImageDrafts(images: $images)
            switch composerMode {
            case .send(let running):
                sendRow(running: running)
            case .stopped(let hint):
                HStack {
                    #if os(iOS)
                    if hint == nil && canSetOnResume { AgentComposerAdd(images: $images, error: $error, openSkills: session.engine == .claude || session.engine == .codex || session.engine == .zcode ? { showingSkills = true } : nil, permissions: permissionChoice) }
                    #endif
                    Text(hint ?? "会话已停止").font(.footnote).foregroundStyle(Theme.muted)
                    Spacer()
                    if hint == nil && canSetOnResume { modelChip }
                    #if os(macOS)
                    if hint == nil && canSetOnResume && !effortLevels.isEmpty { effortButton }
                    #endif
                    Button(sending ? "正在继续…" : "继续") { Task { await resume() } }
                        .buttonStyle(.borderedProminent).tint(Theme.nexAgentSolid).disabled(hint != nil || sending)
                }
            case .blocked(let hint):
                Text(hint).font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .padding(14)
        .onAppear {
            draft = AgentDrafts.texts[session.key] ?? ""
            effort = AgentDrafts.efforts[session.key]
            chosenModel = AgentDrafts.models[session.key] ?? ""
            images = AgentDrafts.images[session.key] ?? []
            permission = AgentDrafts.permissions[session.key]
        }
        .sheet(isPresented: $showingSkills) {
            ChatSkillPicker(load: { try await model.skills(deviceId: session.deviceId, engine: session.engine, cwd: session.cwd, key: session.key) }) { skill in
                draft = session.engine == .claude && session.sendVia == "inbox" ? "请调用 Skill 工具使用「\(skill.name)」技能。\n" + draft : skill.adding(to: draft, engine: session.engine)
            }
        }
        .onChange(of: draft) { _, text in AgentDrafts.texts[session.key] = text }
        .onChange(of: images) { _, value in AgentDrafts.images[session.key] = value.isEmpty ? nil : value }
        .task(id: canSetOnResume || canSetOnSend) {
            guard canSetOnResume || canSetOnSend else { return }
            let options = await model.models(deviceId: session.deviceId, engine: session.engine)
            if !Task.isCancelled { catalog = options }
        }
        .onChange(of: chosenModel) { _, name in AgentDrafts.models[session.key] = name }
        #if os(iOS)
        .sheet(isPresented: $showingModels) {
            AgentComposerModelOptions(catalog: catalog, model: $chosenModel, levels: effortLevels, selection: selectedEffort, chooseEffort: setEffort)
        }
        #endif
    }

    private var tooLong: Bool { draft.utf8.count > CoreClient.cliMaxSendBytes }
    private var canSend: Bool { (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty) && !tooLong && !sending }

    private func queueRows(_ queue: CliSessionQueue) -> some View {
        let hidden = Set(guides.filter { $0.key == session.key }.map(\.id))
        return VStack(alignment: .leading) {
            ForEach(queue.entries.filter { !hidden.contains($0.id) && ["pending", "claimed", "uncertain", "failed"].contains($0.status) }) { entry in
                HStack {
                    if let original = editing, original.id == entry.id, entry.status == "pending" {
                        TextField("编辑排队消息", text: $editedText)
                        Button("保存") { queueAction { try await model.editQueued(original, text: editedText); editing = nil } }
                            .disabled(editedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        Button("取消") { editing = nil }
                    } else {
                        Text(entry.text).lineLimit(3)
                        Spacer()
                        if entry.status == "pending" {
                            if canSteer && queue.pauseReason != "stopped" {
                                Button(steerLabel) {
                                    let items = model.transcript(session.key).items
                                    let guide = AgentGuide(key: session.key, id: entry.id, text: entry.text,
                                        at: Int(Date().timeIntervalSince1970 * 1000), known: Set(items.map(\.id)),
                                        after: items.last?.id, tail: items.last { $0.kind == .assistant })
                                    guides.append(guide)
                                    queueAction {
                                        do {
                                            let sent = try await model.steerQueued(entry, questionId: steerQuestionId, interruptWaiting: interruptWaiting)
                                            if sent.status == "pending", steerQuestionId != nil || interruptWaiting { guides.removeAll { $0.id == entry.id } }
                                            if sent.status == "uncertain", let at = guides.firstIndex(where: { $0.id == entry.id }) { guides[at].uncertain = true }
                                        }
                                        catch {
                                            let failure = CoreError.wrap(error)
                                            if failure.kind == .network || failure.code == "unknown" || (failure.status ?? 0) >= 500 {
                                                if let at = guides.firstIndex(where: { $0.id == entry.id }) { guides[at].uncertain = true }
                                            } else { guides.removeAll { $0.id == entry.id } }
                                            throw error
                                        }
                                    }
                                }
                            }
                            Button("编辑") { editing = entry; editedText = entry.text }
                        } else {
                            Text(session.engine == .codex && entry.status == "failed" && entry.errorCode == "read_only" ? "消息未发送，请检查 Codex 终端" : (["uncertain": "待确认", "claimed": "投递中", "failed": "发送失败"][entry.status] ?? "投递中"))
                        }
                    }
                }
            }
            if queue.paused && queue.entries.contains(where: { $0.status == "pending" }) {
                Button("继续队列") { queueAction { try await model.resumeQueue(session.key) } }
            }
        }.font(.caption).disabled(sending)
    }

    private func queueAction(_ action: @escaping @MainActor () async throws -> Void) {
        sending = true
        Task {
            defer { sending = false }
            do { try await action() } catch { self.error = CliErrorText.text(for: error, fallback: "操作失败") }
        }
    }

    private func sendRow(running: Bool) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            AgentComposerAdd(images: $images, error: $error, openSkills: session.engine == .claude || session.engine == .codex || session.engine == .zcode ? { showingSkills = true } : nil, permissions: permissionChoice)
            TextField("发消息", text: $draft, axis: .vertical)
                .lineLimit(1...5).textFieldStyle(.plain)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Theme.wash, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .onSubmit { if canSend { Task { await send() } } }
            if tooLong { Text("内容太长").font(.caption).foregroundStyle(Theme.danger) }
            modelChip
            AgentContextRing(usage: session.context)
            #if os(macOS)
            if (canSetOnSend || canConfigureProtocol) && !effortLevels.isEmpty { effortButton }
            #endif
            // one button: Stop while a turn runs and the box is empty, Send once there is something to send
            if running && !sending && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty {
                Button { Task { await interrupt() } } label: { Image(systemName: "stop.circle.fill").font(.system(size: 26)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.foreground).accessibilityLabel("停止")
            } else {
                Button { Task { await send() } } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 26)) }
                    .buttonStyle(.plain).foregroundStyle(canSend ? Theme.nexAgentSolid : Theme.offline)
                    .disabled(!canSend).accessibilityLabel("发送")
            }
        }
    }

    /// The model the next message or continue uses, by the name the catalog gives it.
    private var modelTitle: String {
        let id = chosenModel.isEmpty ? (session.model ?? catalog.current ?? "") : chosenModel
        guard !id.isEmpty else { return "默认模型" }
        return CliLaunches.modelDisplayLabel(catalog.models, id: id)
    }

    /// The model on one line left of the context ring, cut at its width; it opens the model choices.
    @ViewBuilder private var modelChip: some View {
        if (session.engine == .agy || session.engine == .zcode) && session.state != .stopped && !canConfigureProtocol {
            modelChipLabel
        } else if canSetOnResume || canSetOnSend {
            #if os(iOS)
            Button { showingModels = true } label: { modelChipLabel }
                .buttonStyle(.plain)
                .accessibilityLabel("模型设置").accessibilityValue(modelTitle)
            #else
            Menu {
                AgentMacModelMenuContent(catalog: catalog, selection: $chosenModel, fallback: session.model ?? catalog.current ?? "")
            } label: { modelChipLabel }
                .menuStyle(.borderlessButton).menuIndicator(.hidden)
                .frame(maxWidth: 180)
                .accessibilityLabel("模型设置").accessibilityValue(modelTitle)
            #endif
        }
    }

    private var modelChipLabel: some View {
        Text(modelTitle).font(.footnote).foregroundStyle(Theme.muted)
            .lineLimit(1).truncationMode(.tail)
            #if os(iOS)
            .frame(maxWidth: 110, alignment: .trailing)
            #endif
            .frame(height: 34).contentShape(Rectangle())
    }

    private func setEffort(_ level: String) {
        effort = level
        AgentDrafts.efforts[session.key] = level
    }

    private var effortButton: some View {
        Button { showingEffort.toggle() } label: {
            HStack(spacing: 4) {
                Text(CliLaunches.effortLabel(selectedEffort))
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
            }
            .font(.footnote)
            .padding(.horizontal, 8).frame(height: 34)
            .background(Theme.wash, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("思考强度")
        .accessibilityValue(CliLaunches.effortLabel(selectedEffort))
        .popover(isPresented: $showingEffort, arrowEdge: .bottom) {
            ChatEffortChoices(levels: effortLevels, selection: selectedEffort, label: CliLaunches.effortLabel, tint: Theme.nexAgentAccent, choose: setEffort)
            .padding(12).frame(width: 305)
            #if os(iOS)
            .presentationCompactAdaptation(.popover)
            #endif
        }
    }

    /// The box empties and the message shows in the conversation at once; a failure puts it back.
    private func send() async {
        guard canSend else { return }
        deliveryNotice = nil
        let text = draft
        let submittedImages = images
        let queued = (session.state == .running || session.state == .waiting) && ((session.liveIn == .nexbot && session.terminal != nil) || (session.engine == .claude && session.sendVia == "inbox") || managedProtocol)
        let entry = AgentPendingSend(text: CliLaunches.messagePreview(text, images: submittedImages), uploading: !submittedImages.isEmpty, known: Set(model.transcript(session.key).items.map(\.id)))
        pending.append(entry)
        draft = ""; images = []
        sending = true; error = ""
        defer { sending = false }
        do {
            let message = try await model.imageMessage(session.key, text: text, images: submittedImages)
            if canConfigureProtocol {
                let previousModel = AgentDrafts.appliedModels[session.key]
                let requestedModel = chosenModel.isEmpty ? (previousModel == nil ? nil : catalog.current) : chosenModel
                let level = effort == nil ? nil : resolvedEffort
                let mode = pendingPermission
                if (requestedModel != nil && requestedModel != previousModel) || (level != nil && level != AgentDrafts.appliedEfforts[session.key]) || mode != nil {
                    _ = try await model.continueSession(session.key, effort: level, model: requestedModel, permissions: mode)
                    AgentDrafts.appliedModels[session.key] = requestedModel
                    AgentDrafts.appliedEfforts[session.key] = level
                    if let mode { tookPermission(session.key, mode) }
                }
            }
            if canSetOnSend {
                let applied = AgentDrafts.appliedModels[session.key]
                let wanted = chosenModel.isEmpty ? (applied == nil ? nil : catalog.current) : chosenModel
                if let wanted, wanted != applied {
                    try await model.send(session.key, text: "/model " + wanted)
                    AgentDrafts.appliedModels[session.key] = wanted
                    AgentDrafts.appliedEfforts[session.key] = nil
                }
            }
            // only a level picked here: the default would type /effort before the first message of every visit
            if canSetOnSend, effort != nil, let level = resolvedEffort, AgentDrafts.appliedEfforts[session.key] != level {
                try await model.send(session.key, text: "/effort " + level)
                AgentDrafts.appliedEfforts[session.key] = level
            }
            if let index = pending.firstIndex(where: { $0.id == entry.id }) {
                pending[index].text = message
                pending[index].uploading = false
            }
            if queued {
                try await model.enqueue(session.key, text: message)
                pending.removeAll { $0.id == entry.id }
            } else if try await model.send(session.key, text: message)?.nativeQueued == true,
                      let index = pending.firstIndex(where: { $0.id == entry.id }) {
                pending[index].nativeQueued = true
            }
        } catch {
            pending.removeAll { $0.id == entry.id }
            if draft.isEmpty && images.isEmpty { draft = text; images = submittedImages }
            self.error = CliErrorText.text(for: error, fallback: "没能发送")
        }
    }

    private func interrupt() async {
        error = ""
        do { try await model.interrupt(session.key) } catch { self.error = CliErrorText.text(for: error) }
    }

    private func resume() async {
        sending = true; error = ""
        do {
            let level = canSetOnResume ? resolvedEffort : nil
            let requestedModel = canSetOnResume && !chosenModel.isEmpty ? chosenModel : nil
            let mode = pendingPermission
            let next = try await model.continueSession(session.key, effort: level, model: requestedModel, permissions: mode)
            if let mode { tookPermission(next, mode) }
            AgentDrafts.efforts[next] = effort
            AgentDrafts.appliedEfforts[next] = level
            AgentDrafts.models[next] = requestedModel
            AgentDrafts.appliedModels[next] = requestedModel
            if !draft.isEmpty { AgentDrafts.texts[next] = draft }
            AgentDrafts.images[next] = images.isEmpty ? nil : images
            onKeyChange(next)
        }
        catch { self.error = CliErrorText.text(for: error, fallback: "没能继续") }
        sending = false
    }
}

/// How full the session's context is: a ring that fills with the share of the window the last request used (amber from
/// 70%, red from 90%); dashed while nothing is known. Tapping shows the numbers.
struct AgentContextRing: View {
    let usage: CliContextUsage?
    @State private var open = false

    private var color: Color {
        switch CliContext.level(usage) {
        case .full: Color(hex: 0xC2410C)
        case .high: Theme.approval
        default: Theme.success
        }
    }

    var body: some View {
        Button { open.toggle() } label: {
            ZStack {
                if let share = CliContext.share(usage) {
                    Circle().stroke(Theme.border, lineWidth: 2.2)
                    Circle().trim(from: 0, to: max(0.04, share)).stroke(color, style: StrokeStyle(lineWidth: 2.2, lineCap: .round)).rotationEffect(.degrees(-90))
                } else {
                    Circle().stroke(Theme.muted, style: StrokeStyle(lineWidth: 1.4, dash: [2, 2]))
                }
            }
            .frame(width: 16, height: 16).padding(5).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(CliContext.summary(usage))
        .accessibilityLabel(CliContext.summary(usage))
        .popover(isPresented: $open, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("上下文").font(.system(size: 13, weight: .semibold))
                    Spacer()
                    if let share = CliContext.share(usage) { Text("\(Int((share * 100).rounded()))%").font(.system(size: 15, weight: .semibold)).monospacedDigit() }
                }
                if let share = CliContext.share(usage) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.wash)
                            Capsule().fill(color).frame(width: max(4, geo.size.width * share))
                        }
                    }
                    .frame(height: 6)
                }
                Text(detail).font(.caption).foregroundStyle(Theme.muted).monospacedDigit()
            }
            .padding(14).frame(width: 240)
            #if os(iOS)
            .presentationCompactAdaptation(.popover)
            #endif
        }
    }

    private var detail: String {
        guard let usage else { return "暂无记录" }
        guard let window = usage.window else { return "已用 \(CliContext.tokens(usage.used)) tokens" }
        return "已用 \(CliContext.tokens(usage.used)) / \(CliContext.tokens(window)) tokens"
    }
}
