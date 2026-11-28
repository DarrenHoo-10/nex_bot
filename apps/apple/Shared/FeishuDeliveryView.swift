import SwiftUI
import NexClientKit

/// Shared Feishu delivery, finance channel handoff, and outbox reconciliation controls
/// (ports `FeishuDeliverySettings.tsx`, `FinanceChannelSettings.tsx`, and `FeishuOutboxSettings.tsx`).
struct FeishuDeliveryView: View {
    let workspace: WorkspaceStore
    @State private var apps: [FeishuSharedApp] = []
    @State private var destinations: [FeishuDestination] = []
    @State private var subscriptions: [FeishuSubscription] = []
    @State private var selectedAppID = ""
    @State private var bindCode = ""
    @State private var claimChatID = ""
    @State private var editing: FeishuSubscription?
    @State private var subChatID = ""
    @State private var subInstanceID = ""
    @State private var subKinds = ""
    @State private var subScenario = "proactive"
    @State private var busy = false
    @State private var error = ""

    private var selected: String {
        if !selectedAppID.isEmpty, apps.contains(where: { $0.appID == selectedAppID }) { return selectedAppID }
        return apps.first?.appID ?? ""
    }
    private var selectedApp: FeishuSharedApp? { apps.first { $0.appID == selected } }
    private var activeDestinations: [FeishuDestination] { destinations.filter { $0.appID == selected && $0.enabled } }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !apps.isEmpty || !subscriptions.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    Text("账号与投递").font(.system(size: 14, weight: .semibold))
                    if !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(Theme.danger).textSelection(.enabled)
                    }
                    if selectedApp?.canManageChannel == true {
                        FeishuFinanceChannelSection(workspace: workspace, appID: selected).id(selected)
                        Divider().overlay(Theme.border)
                    }
                    if !apps.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Picker("应用", selection: Binding(get: { selected }, set: { next in
                                selectedAppID = next; bindCode = ""; editing = nil; syncDestinationDefault()
                            })) {
                                ForEach(apps) { app in
                                    Text("\(app.appID) · \(app.bound ? "已绑定" : "未绑定")").tag(app.appID)
                                }
                            }
                            .pickerStyle(.menu)

                            Text(selectedApp?.status == "connected" ? "通道已连接" : "通道未连接")
                                .font(.caption).foregroundStyle(selectedApp?.status == "connected" ? Theme.success : Theme.muted)

                            HStack(spacing: 8) {
                                Button(selectedApp?.bound == true ? "重新绑定" : "生成账号绑定码") {
                                    act { bindCode = try await workspace.client.feishuAccountBind(appID: selected) }
                                }
                                .buttonStyle(ConversationActionButtonStyle(size: .compact))
                                .disabled(busy)
                                if selectedApp?.bound == true {
                                    Button("解除账号绑定") {
                                        act { try await workspace.client.feishuAccountUnbind(appID: selected); bindCode = "" }
                                    }
                                    .buttonStyle(ConversationActionButtonStyle(tone: .dark, size: .compact))
                                    .disabled(busy)
                                }
                            }

                            if !bindCode.isEmpty {
                                Text("在飞书私聊发送：\(bindCode)")
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(Theme.foreground)
                                    .textSelection(.enabled)
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8))
                            }

                            if selectedApp?.bound == true {
                                HStack(spacing: 8) {
                                    TextField("群 ID", text: $claimChatID)
                                        .textFieldStyle(.roundedBorder)
                                        .font(.system(size: 12.5))
                                        .autocorrectionDisabled()
                                    Button("绑定已验证的群") {
                                        let chat = claimChatID.trimmingCharacters(in: .whitespacesAndNewlines)
                                        guard !chat.isEmpty else { return }
                                        act { try await workspace.client.feishuAccountClaim(appID: selected, chatID: chat); claimChatID = "" }
                                    }
                                    .buttonStyle(ConversationActionButtonStyle(size: .compact))
                                    .disabled(busy || claimChatID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                }
                            }
                        }
                    }

                    if !subscriptions.isEmpty || !activeDestinations.isEmpty {
                        Divider().overlay(Theme.border)
                        Text("订阅").font(.system(size: 13, weight: .semibold))
                        ForEach(subscriptions) { sub in
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(sub.chatID) · \(sub.kinds.joined(separator: "、"))")
                                        .font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                                    Text("\(sub.instanceID) · \(sub.enabled ? "已启用" : "已暂停")")
                                        .font(.caption2).foregroundStyle(Theme.muted)
                                }
                                Spacer(minLength: 4)
                                Button("修改") { startEdit(sub) }
                                    .font(.caption.weight(.medium)).foregroundStyle(Theme.brand).buttonStyle(.plain).disabled(busy)
                                Button(sub.enabled ? "暂停" : "恢复") {
                                    act {
                                        try await workspace.client.saveFeishuSubscription(FeishuSubscriptionSaveBody(
                                            appId: sub.appID, chatId: sub.chatID, instanceId: sub.instanceID,
                                            kinds: sub.kinds, scenarios: sub.scenarios, audience: sub.audience,
                                            enabled: !sub.enabled, version: sub.version
                                        ))
                                    }
                                }
                                .font(.caption.weight(.medium)).foregroundStyle(Theme.muted).buttonStyle(.plain).disabled(busy)
                            }
                            .padding(.vertical, 4)
                        }

                        if !activeDestinations.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Picker("目的地", selection: $subChatID) {
                                    ForEach(activeDestinations) { dest in
                                        Text("\(dest.chatType == "group" ? "群" : "私人") · \(dest.chatID)").tag(dest.chatID)
                                    }
                                }
                                .pickerStyle(.menu)
                                .disabled(editing != nil)

                                TextField("金融实例 ID", text: $subInstanceID)
                                    .textFieldStyle(.roundedBorder).font(.system(size: 12.5)).disabled(editing != nil).autocorrectionDisabled()
                                TextField("内容类型（多个用逗号分隔）", text: $subKinds)
                                    .textFieldStyle(.roundedBorder).font(.system(size: 12.5)).autocorrectionDisabled()
                                Picker("适用场景", selection: $subScenario) {
                                    Text("主动推送").tag("proactive")
                                    Text("主动推送与话题回复").tag("all")
                                }
                                .pickerStyle(.segmented)
                                HStack(spacing: 8) {
                                    Button(editing != nil ? "保存修改" : "新增订阅") { saveSubscription() }
                                        .buttonStyle(ConversationActionButtonStyle(size: .compact))
                                        .disabled(busy || subChatID.isEmpty || subInstanceID.trimmingCharacters(in: .whitespaces).isEmpty || parsedKinds.isEmpty)
                                    if editing != nil {
                                        Button("取消") { editing = nil; subInstanceID = ""; subKinds = ""; subScenario = "proactive" }
                                            .font(.caption).foregroundStyle(Theme.muted).buttonStyle(.plain)
                                    }
                                }
                            }
                            .padding(12)
                            .background(Theme.wash, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))
            }

            FeishuOutboxSection(workspace: workspace)
        }
        .task(id: workspace.state?.feishu) { await reload() }
    }

    private var parsedKinds: [String] {
        subKinds.split(whereSeparator: { $0 == "," || $0 == "，" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func syncDestinationDefault() {
        if let first = activeDestinations.first, !activeDestinations.contains(where: { $0.chatID == subChatID }) {
            subChatID = first.chatID
        }
    }

    private func startEdit(_ sub: FeishuSubscription) {
        selectedAppID = sub.appID
        editing = sub
        subChatID = sub.chatID
        subInstanceID = sub.instanceID
        subKinds = sub.kinds.joined(separator: ",")
        subScenario = sub.scenarios.contains("all") ? "all" : "proactive"
    }

    private func saveSubscription() {
        let appID = editing?.appID ?? selected
        let dest = destinations.first { $0.appID == appID && $0.chatID == (editing?.chatID ?? subChatID) }
        let body = FeishuSubscriptionSaveBody(
            appId: appID,
            chatId: editing?.chatID ?? subChatID,
            instanceId: (editing?.instanceID ?? subInstanceID).trimmingCharacters(in: .whitespacesAndNewlines),
            kinds: parsedKinds,
            scenarios: subScenario == "all" ? ["all"] : ["proactive"],
            audience: dest?.chatType == "group" ? "public" : "private",
            enabled: true,
            version: editing?.version
        )
        act {
            try await workspace.client.saveFeishuSubscription(body)
            editing = nil; subInstanceID = ""; subKinds = ""
        }
    }

    private func reload() async {
        do {
            async let nextApps = workspace.client.feishuAccounts()
            async let nextDests = workspace.client.feishuDestinations()
            async let nextSubs = workspace.client.feishuSubscriptions()
            let (a, d, s) = try await (nextApps, nextDests, nextSubs)
            apps = a; destinations = d; subscriptions = s
            syncDestinationDefault()
        } catch {
            // Endpoint absent on older Cores or non-owner session; stay silent.
        }
    }

    private func act(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = ""
        Task {
            defer { busy = false }
            do { try await work(); await reload() }
            catch { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
        }
    }
}

/// Finance Feishu channel ownership handoff (`FinanceChannelSettings.tsx`).
private struct FeishuFinanceChannelSection: View {
    let workspace: WorkspaceStore
    let appID: String
    @State private var channel: FeishuFinanceChannel?
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let channel {
                HStack(spacing: 6) {
                    Text("金融飞书通道 · 当前收发方：").font(.caption).foregroundStyle(Theme.muted)
                    Text(channel.ownerLabel).font(.caption.weight(.semibold)).foregroundStyle(Theme.foreground)
                }
                HStack(spacing: 8) {
                    if channel.owner == "paused" {
                        Button("交给 NexBot") { transfer("core") }
                            .buttonStyle(ConversationActionButtonStyle(size: .compact)).disabled(busy)
                        Button("交给 nex_stock") { transfer("stock") }
                            .buttonStyle(ConversationActionButtonStyle(tone: .dark, size: .compact)).disabled(busy)
                    } else {
                        Button("暂停收发以切换") { transfer("paused") }
                            .buttonStyle(ConversationActionButtonStyle(tone: .dark, size: .compact)).disabled(busy)
                    }
                    if busy { ProgressView().controlSize(.small) }
                }
                if let reportErr = channel.reportsError {
                    Text("报告同步 · \(reportErr)").font(.caption).foregroundStyle(Theme.muted)
                }
            }
            if !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(Theme.danger).textSelection(.enabled)
            }
        }
        .task(id: appID) { await load() }
    }

    private func load() async {
        do {
            let value = try await workspace.client.financeChannel()
            if value.appID == appID { channel = value }
        } catch {
            self.error = (error as? CoreError)?.message ?? error.localizedDescription
        }
    }

    private func transfer(_ owner: String) {
        guard let channel, !busy else { return }
        busy = true; error = ""
        Task {
            defer { busy = false }
            do {
                self.channel = try await workspace.client.transferFinanceChannel(appID: appID, expectedVersion: channel.version, owner: owner)
            } catch {
                let raw = (error as? CoreError)?.message ?? error.localizedDescription
                self.error = raw.contains("FINANCE_STOCK_RECEIVER_STILL_RUNNING")
                    ? "原飞书连接仍在运行。保持暂停，重启承载旧接收器的 Stock 进程后，再交给 NexBot。"
                    : raw
                await load()
            }
        }
    }
}

/// Owner-only Feishu outbox reconciliation panel (`FeishuOutboxSettings.tsx`).
private struct FeishuOutboxSection: View {
    let workspace: WorkspaceStore
    @State private var parts: [FeishuDeliveryPart] = []
    @State private var error = ""
    @State private var busy = false
    @State private var actions: [String: String] = [:]
    @State private var messageIDs: [String: String] = [:]
    @State private var evidences: [String: String] = [:]
    @State private var confirmed: [String: Bool] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !parts.isEmpty || !error.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("投递状态与对账").font(.system(size: 14, weight: .semibold))
                        Spacer()
                        Button("刷新投递状态") { Task { await reload() } }
                            .font(.caption.weight(.medium)).foregroundStyle(Theme.brand).buttonStyle(.plain).disabled(busy)
                    }
                    Text("飞书发送去重仅有效一小时。超过窗口且结果不明时，该分段及后续分段暂停，需主人核对；其他话题继续投递。")
                        .font(.caption).foregroundStyle(Theme.muted)
                    if !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(Theme.danger).textSelection(.enabled)
                    }
                    ForEach(parts) { part in
                        outboxPartCard(part)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))
            }
        }
        .task(id: workspace.state?.feishu) { await reload() }
    }

    private func outboxPartCard(_ part: FeishuDeliveryPart) -> some View {
        let act = Binding(get: { actions[part.id] ?? "delivered" }, set: { actions[part.id] = $0 })
        let msgID = Binding(get: { messageIDs[part.id] ?? "" }, set: { messageIDs[part.id] = $0 })
        let ev = Binding(get: { evidences[part.id] ?? "" }, set: { evidences[part.id] = $0 })
        let conf = Binding(get: { confirmed[part.id] ?? false }, set: { confirmed[part.id] = $0 })

        return DisclosureGroup("\(part.stateLabel) · 第 \(part.part + 1) 段 · \(part.chatID)") {
            VStack(alignment: .leading, spacing: 8) {
                Text("应用 \(part.appID) · 话题 \(part.conversationID) · 尝试 \(part.attempts) 次 · \(part.operation == "patch" ? "更新卡片" : "发送消息")")
                    .font(.caption2).foregroundStyle(Theme.muted)
                let firstStr = part.firstPostAt.map { TimeFormat.formatTime($0) } ?? "无可信发送时间"
                let dedupStr = part.dedupUntil.map { " · 去重截止：\(TimeFormat.formatTime($0))" } ?? ""
                let idStr = part.messageID.map { " · \($0)" } ?? ""
                Text("首次实际发送：\(firstStr)\(dedupStr)\(idStr)").font(.caption2).foregroundStyle(Theme.muted)
                ToolCodeBlock(text: part.previewText, maxHeight: 160)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8))
                ForEach(part.reconciliation) { entry in
                    Text("对账 · \(entry.recordedAt.map { TimeFormat.formatTime($0) } ?? "") · \(entry.action == "delivered" ? "已核验送达" : "已核实未送达") · \(entry.evidence)\(entry.messageID.map { " · \($0)" } ?? "")")
                        .font(.caption2).foregroundStyle(Theme.muted)
                }
                if part.state == "needs_reconciliation" {
                    Picker("核对结果", selection: act) {
                        Text("已送达，核验并登记").tag("delivered")
                        Text("已核实未送达，允许重新发送").tag("not_delivered")
                    }
                    .pickerStyle(.menu)
                    if act.wrappedValue == "delivered" {
                        TextField("已送达的飞书 message_id (om_…)", text: msgID)
                            .textFieldStyle(.roundedBorder).font(.system(size: 12)).autocorrectionDisabled()
                    }
                    TextField("人工核对依据（记录核对的群、时间与结果）", text: ev, axis: .vertical)
                        .lineLimit(2...4).textFieldStyle(.roundedBorder).font(.system(size: 12))
                    if act.wrappedValue == "not_delivered" {
                        Toggle("选择重新发送时，我已核实此分段未送达", isOn: conf)
                            .font(.caption)
                    }
                    Text("登记已送达会验证原应用、群、发送者与完整卡片内容。重新发送会复查当前目的地和订阅规则。")
                        .font(.caption2).foregroundStyle(Theme.muted)
                    Button("提交对账") { submitReconcile(part) }
                        .buttonStyle(ConversationActionButtonStyle(size: .compact))
                        .disabled(busy || ev.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(.top, 8)
        }
        .font(.system(size: 12.5, weight: .medium))
        .padding(10)
        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func reload() async {
        do {
            let all = try await workspace.client.feishuDeliveries()
            parts = all.filter { $0.state == "needs_reconciliation" }
            error = ""
        } catch {
            // Silently ignore if endpoint unavailable on older Cores; show error only if parts existed.
            if !parts.isEmpty { self.error = (error as? CoreError)?.message ?? error.localizedDescription }
        }
    }

    private func submitReconcile(_ part: FeishuDeliveryPart) {
        guard !busy else { return }
        busy = true; error = ""
        let action = actions[part.id] ?? "delivered"
        let messageID = messageIDs[part.id] ?? ""
        let evidence = evidences[part.id] ?? ""
        let isConfirmed = confirmed[part.id] ?? false
        Task {
            defer { busy = false }
            do {
                try await workspace.client.reconcileFeishuDelivery(
                    id: part.id, action: action, messageID: messageID, evidence: evidence, confirmedNotDelivered: isConfirmed
                )
                await reload()
            } catch {
                self.error = (error as? CoreError)?.message ?? error.localizedDescription
            }
        }
    }
}
