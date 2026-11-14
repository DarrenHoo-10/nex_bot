import SwiftUI
import NexClientKit

/// Both Apple apps address the same Core topic; a late feed never replaces a different open topic.
struct FinanceTopicsView: View {
    let workspace: WorkspaceStore
    let botID: String
    @Environment(\.scenePhase) private var scenePhase
    @State private var topics: [FinanceTopic] = []
    @State private var selected: String?
    @State private var messages: [AgentMessage] = []
    @State private var streaming = ""
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
    private var current: FinanceTopic? { topics.first { $0.id == selected } }
    private var draft: Binding<String> { Binding(get: { drafts[selected ?? "new"] ?? "" },set: { drafts[selected ?? "new"] = $0 }) }
    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text(workspace.bot(botID)?.name ?? "金融助手").font(.headline)
                Spacer()
                Button("模型") {modelOpen=true}
                Button("新对话",systemImage:"plus") { selected = nil; messages = []; streaming = "";editingMessageID=nil;taskRows=[]; generation += 1 }
                    .disabled(sending || pending != nil)
            }
            if workspace.connection != .connected { ProgressView("正在重新同步…") }
            else {
                if let current {
                    HStack(alignment: .top) {
                        Button("返回聊天") {
                            selected = nil; messages = []; streaming = ""; editingMessageID = nil; taskRows = []; generation += 1
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(current.title).font(.headline)
                            Text(current.destinationLabel).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                }
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:12) {
                        ForEach(topics) { topic in topicCard(topic) }
                        if topics.isEmpty { Text("新建一段对话").foregroundStyle(.secondary) }
                    }
                }
                if let errorText { Text(errorText).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
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
        .padding(16)
        .task(id:workspace.sync) { await reload() }
        .task(id:selected) { await loadSelected() }
        .task(id:scenePhase) { if scenePhase == .active { await reload() } }
        .onChange(of:workspace.connection) { _,value in if value != .connected { topics=[];messages=[];streaming="";taskRows=[];readSeq=[:];generation += 1 } }
        .onDisappear { generation += 1 }
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
                Button { guard !sending && pending == nil else{return};selected=topic.id;editingMessageID=nil;taskRows=[] } label: { Text(topic.title).font(.headline).multilineTextAlignment(.leading) }.buttonStyle(.plain)
                Spacer()
                if topic.unread > 0 { Text("\(topic.unread) 未读").font(.caption).foregroundStyle(.tint) }
                if topic.activeTask != nil { ProgressView().controlSize(.small) }
            }
            Text("\(topic.destinationLabel) · \(topic.replyCount) 条消息").font(.caption).foregroundStyle(.secondary)
            if selected == topic.id && messages.count >= 200 {Button("加载更早的消息") {Task {await loadOlder(topic.id)}}}
            ForEach(selected == topic.id ? messages : topic.messages) { message in
                VStack(alignment:.leading,spacing:3) {
                    Text(message.role == "user" ? "我" : workspace.bot(botID)?.name ?? "金融助手").font(.caption).foregroundStyle(.secondary)
                    MarkdownText(source:message.content)
                    if selected == topic.id && message.role == "user" && message.taskID == nil && pending == nil {Button("编辑待运行消息"){editingMessageID=message.id;drafts[topic.id]=message.content}.font(.caption)}
                }
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
            Button(selected == topic.id ? "正在回复此话题" : "回复话题") { selected=topic.id;editingMessageID=nil;taskRows=[] }.disabled(sending || pending != nil)
        }
        .padding(14).frame(maxWidth:.infinity,alignment:.leading)
        .background(.quaternary,in:RoundedRectangle(cornerRadius:14))
    }
    private func reload() async {
        guard workspace.connection == .connected else{return}
        let epoch=generation
        do {
            let result=try await workspace.client.financeTopics(botID:botID)
            guard epoch==generation,workspace.connection == .connected,!Task.isCancelled else{return}
            topics=result;await loadSelected()
        } catch { if epoch==generation {errorText=error.localizedDescription} }
    }
    private func loadSelected() async {
        guard let id=selected,workspace.connection == .connected else{return}
        let epoch=generation
        do {
            let feed=try await workspace.client.topicFeed(botID:botID,conversationID:id)
            guard epoch==generation,id==selected,workspace.connection == .connected,!Task.isCancelled else{return}
            let tasks=try await workspace.client.topicTasks(botID:botID,conversationID:id)
            guard epoch==generation,id==selected,workspace.connection == .connected,!Task.isCancelled else{return}
            messages=feed.messages;taskRows=tasks;streaming=feed.streaming.map(\.text).joined(separator:"\n")
            if scenePhase == .active, let seq=messages.last?.seq,seq > (readSeq[id] ?? 0) {readSeq[id]=seq;try await workspace.client.readTopic(botID:botID,conversationID:id,seq:seq)}
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
        do{let feed=try await workspace.client.topicFeed(botID:botID,conversationID:id,before:before);guard selected==id,workspace.connection == .connected else{return};let existing=Set(messages.map(\.id));messages=feed.messages.filter{!existing.contains($0.id)}+messages}catch{errorText=error.localizedDescription}
    }
    private func retry(_ id:String,taskID:String) async {
        let clientID=taskRetryIDs[taskID] ?? UUID().uuidString;taskRetryIDs[taskID]=clientID
        do{let _:TopicInputResult=try await workspace.client.retryTopic(botID:botID,conversationID:id,taskID:taskID,clientID:clientID);taskRetryIDs.removeValue(forKey:taskID);await reload()}catch{errorText=error.localizedDescription}
    }
    private func stop(_ id:String) async {do {try await workspace.client.cancelTopic(botID:botID,conversationID:id);await reload()}catch{errorText=error.localizedDescription}}
}
