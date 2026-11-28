import SwiftUI
import NexClientKit

/// Both Apple apps address the same Core topic; a late feed never replaces a different open topic.
struct FinanceTopicsView: View {
    let workspace: WorkspaceStore
    let botID: String
    let conversationID: String?
    let onClose: (() -> Void)?

    init(workspace: WorkspaceStore, botID: String, conversationID: String? = nil, onClose: (() -> Void)? = nil) {
        self.workspace = workspace
        self.botID = botID
        self.conversationID = conversationID
        self.onClose = onClose
        _selected = State(initialValue: conversationID)
        _pendingTopicScroll = State(initialValue: conversationID != nil)
    }

    @Environment(\.scenePhase) private var scenePhase
    @State private var topics: [FinanceTopic] = []
    @State private var selected: String?
    @State private var messages: [AgentMessage] = []
    @State private var hasOlder = false
    private var streaming: String { workspace.topicLiveReplies.map(\.text).joined(separator: "\n") }
    @State private var drafts: [String: String] = [:]
    @State private var pending: TopicInput?
    @State private var sending = false
    @State private var errorText: String?
    @State private var generation = 0
    @State private var readSeq: [String:Int] = [:]
    @State private var taskRows: [AgentTask] = []
    @State private var editingMessageID:String?
    @State private var modelOpen=false
    @State private var taskRetryIDs:[String:String]=[:]
    @State private var unreadTopicAnchor: String?
    @State private var didAutoScrollTopics = false
    @State private var pendingTopicReadSeq: Int?
    @State private var unreadMessageAnchor: String?
    @State private var pendingTopicScroll = false
    @State private var topicScrollRevision = 0
    @State private var atBottom = true
    private var current: FinanceTopic? { topics.first { $0.id == selected } }
    private var draft: Binding<String> { Binding(get: { drafts[selected ?? "new"] ?? "" },set: { drafts[selected ?? "new"] = $0 }) }
    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text(workspace.bot(botID)?.name ?? "金融助手").font(.headline)
                Spacer()
                Button("模型") {modelOpen=true}
                if let onClose {
                    Button("关闭", action: onClose)
                } else {
                    Button("新对话",systemImage:"plus") { selected = nil; messages = []; hasOlder = false; editingMessageID = nil; taskRows = []; pendingTopicReadSeq = nil; unreadMessageAnchor = nil; pendingTopicScroll = false; atBottom = true; generation += 1 }
                        .disabled(sending || pending != nil)
                }
            }
            if workspace.connection != .connected { ProgressView("正在重新同步…") }
            else {
                if let current {
                    HStack(alignment: .top) {
                        if conversationID == nil {
                            Button("返回聊天") {
                                selected = nil; messages = []; hasOlder = false; editingMessageID = nil; taskRows = []; pendingTopicReadSeq = nil; unreadMessageAnchor = nil; pendingTopicScroll = false; atBottom = true; generation += 1
                            }
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(current.title).font(.headline)
                            Text(current.destinationLabel).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment:.leading,spacing:12) {
                            if conversationID != nil {
                                if let current { topicCard(current).id(current.id) }
                            } else {
                                ForEach(topics) { topic in topicCard(topic).id(topic.id) }
                                if topics.isEmpty { Text("新建一段对话").foregroundStyle(.secondary) }
                            }
                            Color.clear.frame(height: 1).id("topic-bottom")
                                .onAppear { atBottom = true }
                                .onDisappear { atBottom = false }
                        }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if selected != nil && !atBottom && !messages.isEmpty {
                            Button {
                                atBottom = true
                                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("topic-bottom", anchor: .bottom) }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: "arrow.down").font(.system(size: 12.5, weight: .semibold))
                                        .foregroundStyle(Theme.brand)
                                    Text("回到底部").font(.system(size: 12.5, weight: .medium))
                                        .foregroundStyle(Theme.foreground)
                                }
                                .padding(.horizontal, 12).frame(height: 34)
                                .glass(Capsule(), strong: true, lift: .card)
                            }
                            .buttonStyle(.plain).accessibilityLabel("回到底部")
                            .padding(.trailing, 4).padding(.bottom, 8)
                        }
                    }
                    .onChange(of: unreadTopicAnchor) { _, target in
                        guard selected == nil, let target else { return }
                        DispatchQueue.main.async { proxy.scrollTo(target, anchor: .top) }
                    }
                    .task(id: "\(selected ?? "")|\(topicScrollRevision)") {
                        guard selected != nil, topicScrollRevision > 0 else { return }
                        if let target = unreadMessageAnchor, messages.contains(where: { $0.id == target }) {
                            atBottom = false
                            for delay in [0, 80, 260] {
                                if delay > 0 { try? await Task.sleep(for: .milliseconds(delay)) }
                                guard !Task.isCancelled else { return }
                                proxy.scrollTo(target, anchor: .top)
                            }
                        } else if !messages.isEmpty {
                            atBottom = true
                            for delay in [0, 80, 260] {
                                if delay > 0 { try? await Task.sleep(for: .milliseconds(delay)) }
                                guard !Task.isCancelled else { return }
                                proxy.scrollTo("topic-bottom", anchor: .bottom)
                            }
                        }
                    }
                }
                if let errorText { Text(errorText).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
                if onClose == nil || current != nil {
                    VStack(alignment:.leading,spacing:8) {
                        Text(current?.destinationLabel ?? "新的私人话题").font(.caption).foregroundStyle(.secondary)
                        TextField("发送消息",text:draft,axis:.vertical).lineLimit(2...6).textFieldStyle(.roundedBorder).disabled(sending || pending != nil)
                        HStack {
                            if let current, current.activeTask != nil {
                                Button("停止本题",systemImage:"stop.fill") { Task { await stop(current.id) } }
                            }
                            Spacer()
                            Button(pending == nil ? "发送" : "重试原消息",systemImage:"arrow.up") { Task { await send() } }
                                .disabled(sending || (pending == nil && draft.wrappedValue.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty))
                        }
                    }
                }
            }
        }
        .padding(16)
        .task(id:workspace.sync) { await reload() }
        .task(id:selected) { workspace.watchTopic(botID: botID, conversationID: selected); await loadSelected() }
        .task(id:workspace.topicRecovery) { await loadSelected() }
        .task(id:scenePhase) { if scenePhase == .active { await reload() } }
        .onChange(of:workspace.connection) { _,value in if value != .connected { topics=[];messages=[];hasOlder=false;taskRows=[];readSeq=[:];generation += 1 } }
        .onDisappear { generation += 1; workspace.leaveTopics(botID: botID) }
        #if os(macOS)
        .popover(isPresented:$modelOpen) {ChatModelMenu(workspace:workspace,botID:botID,close:{modelOpen=false},onError:{errorText=$0})}
        #else
        .sheet(isPresented:$modelOpen) {ChatModelSheet(workspace:workspace,botID:botID,onError:{errorText=$0})}
        #endif
        #if os(iOS)
        .toolbar(.visible,for:.navigationBar)
        #endif
    }
    @ViewBuilder private func topicCard(_ topic:FinanceTopic) -> some View {
        VStack(alignment:.leading,spacing:8) {
            HStack {
                Button { guard !sending && pending == nil else{return};selectTopic(topic.id) } label: { Text(topic.title).font(.headline).multilineTextAlignment(.leading) }.buttonStyle(.plain)
                Spacer()
                if topic.unread > 0 { Text("\(topic.unread) 未读").font(.caption).foregroundStyle(.tint) }
                if topic.activeTask != nil { ProgressView().controlSize(.small) }
            }
            Text("\(topic.destinationLabel) · \(topic.replyCount) 条消息").font(.caption).foregroundStyle(.secondary)
            if selected == topic.id && hasOlder {Button("加载更早的消息") {Task {await loadOlder(topic.id)}}}
            ForEach(selected == topic.id ? messages : topic.messages) { message in
                VStack(alignment:.leading,spacing:3) {
                    if selected == topic.id && message.id == unreadMessageAnchor {
                        HStack(spacing: 8) {
                            Rectangle().fill(Theme.brand.opacity(0.24)).frame(height: 1)
                            Text("以下为未读消息")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(Theme.brand)
                                .padding(.horizontal, 8).padding(.vertical, 2)
                                .background(Theme.brandSoft, in: Capsule())
                            Rectangle().fill(Theme.brand.opacity(0.24)).frame(height: 1)
                        }
                        .padding(.vertical, 4)
                    }
                    Text(message.role == "user" ? "我" : workspace.bot(botID)?.name ?? "金融助手").font(.caption).foregroundStyle(.secondary)
                    MarkdownText(source:message.content)
                    if selected == topic.id && message.row.string("input_status") == "pending" && pending == nil {Button("编辑待运行消息"){editingMessageID=message.id;drafts[topic.id]=message.content}.font(.caption)}
                }
                .id(message.id)
            }
            if selected == topic.id {
                ForEach(workspace.approvals.filter {approval in taskRows.contains {$0.id==approval.taskID}}) {approval in
                    #if os(macOS)
                    ApprovalCard(workspace:workspace,approval:approval)
                    #else
                    ApprovalCard(approval:approval,botName:workspace.bot(botID)?.name ?? "") {allow,remember in do {try await workspace.decide(approval,allow:allow,remember:remember)}catch{errorText=error.localizedDescription}}
                    #endif
                }
                ForEach(taskRows.filter {$0.row.string("status")=="failed" || $0.row.string("status")=="cancelled"}) {task in
                    Button("重试本题任务") {Task {await retry(topic.id,taskID:task.id)}}
                }
            }
            if selected == topic.id && !streaming.isEmpty { MarkdownText(source:streaming) }
            if conversationID == nil {
                Button(selected == topic.id ? "正在回复此话题" : "回复话题") { selectTopic(topic.id) }.disabled(sending || pending != nil)
            }
        }
        .padding(14).frame(maxWidth:.infinity,alignment:.leading)
        .background(.quaternary,in:RoundedRectangle(cornerRadius:14))
        .overlay {
            if selected == nil && topic.id == unreadTopicAnchor {
                RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.brand.opacity(0.55), lineWidth: 1.5).allowsHitTesting(false)
            }
        }
    }
    private func selectTopic(_ id: String) {
        guard selected != id else { return }
        let chosen = topics.first { $0.id == id }
        pendingTopicReadSeq = (chosen?.unread ?? 0) > 0 ? (chosen?.readSeq ?? 0) : nil
        unreadMessageAnchor = nil
        pendingTopicScroll = true
        selected = id; editingMessageID = nil; taskRows = []; hasOlder = false
        messages = workspace.cachedTopicMessages(botID: botID, topicID: id)
        generation += 1
    }

    private func reload() async {
        guard workspace.connection == .connected else{return}
        let epoch=generation
        do {
            let result=try await workspace.client.financeTopics(botID:botID, conversationID: conversationID)
            guard epoch==generation,workspace.connection == .connected,!Task.isCancelled else{return}
            topics=result
            if selected == nil && !didAutoScrollTopics {
                didAutoScrollTopics = true
                // Topics arrive newest-first; the last unread entry is the earliest unread topic.
                unreadTopicAnchor = result.last(where: { $0.unread > 0 })?.id
            }
            await loadSelected()
        } catch { if epoch==generation {errorText=error.localizedDescription} }
    }
    private func loadSelected() async {
        guard let id=selected,workspace.connection == .connected else{return}
        let epoch=generation
        do {
            let feed=try await workspace.cachedTopicFeed(botID:botID,conversationID:id)
            guard epoch==generation,id==selected,workspace.connection == .connected,!Task.isCancelled else{return}
            let history = feed.messages
            let tasks=try await workspace.client.topicTasks(botID:botID,conversationID:id)
            guard epoch==generation,id==selected,workspace.connection == .connected,
                  workspace.sync?.sameGeneration(as: feed.sync) == true,!Task.isCancelled else{return}
            if pendingTopicReadSeq == nil, unreadMessageAnchor == nil, let topic = topics.first(where: { $0.id == id }), topic.unread > 0 {
                pendingTopicReadSeq = topic.readSeq
            }
            if let baseline = pendingTopicReadSeq {
                pendingTopicReadSeq = nil
                unreadMessageAnchor = history.first {
                    $0.seq > baseline && $0.role != "user" && !($0.row.string("source_key")?.hasPrefix("stock-history:") ?? false)
                }?.id
            }
            messages=history;taskRows=tasks;hasOlder=feed.hasOlder ?? false
            if pendingTopicScroll {
                pendingTopicScroll = false
                topicScrollRevision += 1
            }
            workspace.updateTopicLiveReplies(feed.streaming, botID: botID, conversationID: id)
            workspace.rememberTopicMessages(history, botID: botID, topicID: id, generation: feed.sync)
            if scenePhase == .active, let seq = messages.last?.seq, seq > (readSeq[id] ?? 0) {
                let previous = readSeq[id]
                readSeq[id] = seq
                do { try await workspace.client.readTopic(botID: botID, conversationID: id, seq: seq) }
                catch { if readSeq[id] == seq { readSeq[id] = previous }; throw error }
            }
        } catch {if epoch==generation,id==selected {errorText=error.localizedDescription}}
    }
    private func send() async {
        guard !sending,workspace.connection == .connected else{return}
        let input=pending ?? TopicInput(botID:botID,text:draft.wrappedValue,conversationID:selected,editingMessageID:editingMessageID)
        pending=input;sending=true;errorText=nil
        defer {sending=false}
        do {
            let result=try await workspace.client.sendTopic(input)
            pending=nil;editingMessageID=nil;drafts[input.conversationId ?? "new"]="";selected=result.conversationId;generation += 1
            await reload()
        } catch {errorText=error.localizedDescription}
    }
    private func loadOlder(_ id:String) async {
        guard let before=messages.first?.seq else{return}
        do{let feed=try await workspace.cachedTopicFeed(botID:botID,conversationID:id,before:before,at:messages.first?.row.int("created_at"));guard selected==id,workspace.connection == .connected,workspace.sync?.sameGeneration(as: feed.sync) == true else{return};hasOlder=feed.hasOlder ?? false;let existing=Set(messages.map(\.id));messages=feed.messages.filter{!existing.contains($0.id)}+messages;workspace.rememberTopicMessages(messages, botID: botID, topicID: id, generation: feed.sync)}catch{errorText=error.localizedDescription}
    }
    private func retry(_ id:String,taskID:String) async {
        let clientID=taskRetryIDs[taskID] ?? UUID().uuidString;taskRetryIDs[taskID]=clientID
        do{let _:TopicInputResult=try await workspace.client.retryTopic(botID:botID,conversationID:id,taskID:taskID,clientID:clientID);taskRetryIDs.removeValue(forKey:taskID);await reload()}catch{errorText=error.localizedDescription}
    }
    private func stop(_ id:String) async {do {try await workspace.client.cancelTopic(botID:botID,conversationID:id);await reload()}catch{errorText=error.localizedDescription}}
}
