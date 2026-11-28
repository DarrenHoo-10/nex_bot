import SwiftUI
import NexClientKit

/// Full unified Todo workspace shared by Mac and iPhone/iPad, aligned with `src/personal/todo/TodoWorkspace.tsx`:
/// formatted period headings, Day status groups, 7-column Week board, Month calendar with event pills,
/// bottom quick-add bar, 1-click completion, interactive checklist steps, inline property edits,
/// Mac right-hand split detail pane, and non-blocking floating toast.
struct TodosView: View {
    let workspace: WorkspaceStore
    let openAgent: (String) -> Void
    @State private var items: [TodoItem] = []
    @State private var period = "day"
    @State private var unscheduledExpanded = true
    @State private var filter = "all"
    @State private var anchor = Date()
    @State private var query = ""
    @State private var quickText = ""
    @State private var selected: String?
    @State private var editing: TodoItem?
    @State private var errorText = ""
    @State private var toastText = ""
    @State private var busy = false
    @State private var loaded = false
    @State private var serial = 0
    @State private var toastTask: Task<Void, Never>?

    private var todayKey: String { TodoDates.key(Date()) }
    private var anchorKey: String { TodoDates.key(anchor) }
    private var days: [Date] { TodoDates.days(anchor, period: period) }
    private var dayKeys: Set<String> { Set(days.map(TodoDates.key)) }

    private var scoped: [TodoItem] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return items }
        return items.filter {
            ($0.title + " " + $0.description + " " + ownerName($0.owner)).lowercased().contains(q)
        }
    }
    private var inRange: [TodoItem] {
        scoped.filter { !$0.date.isEmpty && dayKeys.contains($0.date) }
    }
    private var filtered: [TodoItem] {
        inRange.filter { $0.matches(filter) }
    }
    private var unscheduled: [TodoItem] {
        scoped.filter { $0.date.isEmpty && $0.matches(filter) }
    }
    private var selectedItem: TodoItem? { items.first { $0.id == selected } }

    private func filterCount(_ id: String) -> Int {
        scoped.filter { ($0.date.isEmpty || dayKeys.contains($0.date)) && $0.matches(id) }.count
    }

    private var periodTitleText: String {
        let cal = TodoDates.calendar
        let comps = cal.dateComponents([.year, .month, .day, .weekday], from: anchor)
        let y = comps.year ?? 0, m = comps.month ?? 0, d = comps.day ?? 0
        switch period {
        case "week":
            guard let first = days.first, let last = days.last else { return "\(y)年\(m)月" }
            let fc = cal.dateComponents([.month, .day], from: first)
            let lc = cal.dateComponents([.month, .day], from: last)
            return "\(fc.month ?? 0)月\(fc.day ?? 0)日 – \(lc.month ?? 0)月\(lc.day ?? 0)日"
        case "month":
            return "\(y)年\(m)月"
        default:
            let names = ["", "周日", "周一", "周二", "周三", "周四", "周五", "周六"]
            let wd = comps.weekday.flatMap { names.indices.contains($0) ? names[$0] : nil } ?? ""
            return "\(y)年\(m)月\(d)日 · \(wd)"
        }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            #if os(macOS)
            HStack(spacing: 0) {
                mainWorkspace
                if let item = selectedItem {
                    Divider().overlay(Theme.border)
                    TodoDetailsPane(
                        workspace: workspace,
                        item: item,
                        busy: busy,
                        error: errorText,
                        ownerName: ownerName,
                        onAction: { action, feedback in await act(item, action, feedback) },
                        onPatch: { patch in await savePatched(patch) },
                        onEdit: { editing = item },
                        onClose: { selected = nil },
                        onOpenAgent: { selected = nil; openAgent(item.owner) }
                    )
                    .id(item.id)
                    .frame(width: 344)
                    .background(Theme.card)
                }
            }
            .background { WorkspaceSurface(kind: .stage) }
            #else
            mainWorkspace
                .background { WorkspaceSurface(kind: .stage) }
                .sheet(item: Binding(
                    get: { editing == nil ? selectedItem : nil },
                    set: { if $0 == nil { selected = nil } }
                )) { item in
                    NavigationStack {
                        TodoDetailsPane(
                            workspace: workspace,
                            item: item,
                            busy: busy,
                            error: errorText,
                            ownerName: ownerName,
                            onAction: { action, feedback in await act(item, action, feedback) },
                            onPatch: { patch in await savePatched(patch) },
                            onEdit: { editing = item },
                            onClose: { selected = nil },
                            onOpenAgent: { selected = nil; openAgent(item.owner) }
                        )
                        .id(item.id)
                    }
                    .presentationDetents([.large])
                }
            #endif

            if !toastText.isEmpty {
                HStack(spacing: 7) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
                    Text(toastText).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.foreground)
                }
                .padding(.horizontal, 14).padding(.vertical, 9)
                .glass(Capsule(), strong: true, lift: .card)
                .padding(.bottom, 18)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.18), value: toastText)
        .task(id: workspace.sync) {
            if workspace.state == nil {
                items = []; selected = nil; editing = nil; loaded = false; serial += 1
            } else {
                await load()
            }
        }
        .sheet(item: $editing) { item in
            TodoEditorSheet(workspace: workspace, original: item) { saved in
                await load()
                selected = saved.id
                showToast("已保存待办")
            }
        }
    }

    private var mainWorkspace: some View {
        VStack(spacing: 12) {
            topBar
            if !errorText.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.danger)
                    Text(errorText).font(.caption).foregroundStyle(Theme.danger)
                    Spacer()
                    Button("重新加载") { errorText = ""; Task { await load() } }
                        .font(.caption.weight(.medium)).foregroundStyle(Theme.brand).buttonStyle(.plain)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Theme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            }

            VStack(spacing: 0) {
                contentHeader
                Divider().overlay(Theme.border)
                if !loaded {
                    VStack(spacing: 8) {
                        Spacer()
                        ProgressView()
                        Text("正在读取待办…").font(.caption).foregroundStyle(Theme.muted)
                        Spacer()
                    }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            if period == "month" {
                                monthCalendar
                            } else if period == "week" {
                                weekBoard
                            } else {
                                dayAgenda
                            }
                            if !unscheduled.isEmpty {
                                DisclosureGroup(isExpanded: $unscheduledExpanded) {
                                    VStack(spacing: 8) {
                                        ForEach(unscheduled) { item in todoRow(item) }
                                    }
                                    .padding(.top, 8)
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: "checklist").font(.caption).foregroundStyle(Theme.muted)
                                        Text("未安排").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.foreground)
                                        Text("\(unscheduled.count)")
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(Theme.muted)
                                            .padding(.horizontal, 6).padding(.vertical, 2)
                                            .background(Theme.secondary, in: Capsule())
                                    }
                                }
                                .tint(Theme.muted)
                                .padding(.top, 8)
                            }
                        }
                        .padding(16)
                    }
                    #if os(iOS)
                    .scrollDismissesKeyboard(.interactively)
                    #endif
                }
                Divider().overlay(Theme.border)
                quickAddBar
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.border))
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Theme.muted)
                TextField("搜索待办", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .autocorrectionDisabled()
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }.buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10).frame(height: 34)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
            .frame(maxWidth: 260)

            Spacer(minLength: 6)

            Button { editing = TodoItem(date: anchorKey) } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus").font(.system(size: 12, weight: .semibold))
                    Text("新建待办").font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(Theme.primaryForeground)
                .padding(.horizontal, 13).frame(height: 34)
                .background(Theme.primary, in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(busy)
        }
    }

    private var contentHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                HStack(spacing: 6) {
                    Text("待办").font(.system(size: 18, weight: .bold))
                    Text("\(filtered.count + unscheduled.count)")
                        .font(.system(size: 12, weight: .semibold)).monospacedDigit()
                        .foregroundStyle(Theme.brand)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Theme.brandSoft, in: Capsule())
                }
                Spacer(minLength: 8)
                Picker("时间视角", selection: $period) {
                    Text("日").tag("day")
                    Text("周").tag("week")
                    Text("月").tag("month")
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 160)
                .onChange(of: period) { _, _ in selected = nil }
            }

            HStack(spacing: 8) {
                Text(periodTitleText).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.foreground)
                DatePicker("查看日期", selection: $anchor, displayedComponents: .date)
                    .labelsHidden()
                    .controlSize(.small)
                Spacer(minLength: 4)
                HStack(spacing: 4) {
                    Button { move(-1) } label: {
                        Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold))
                            .frame(width: 28, height: 28).background(Theme.secondary, in: Circle())
                    }.buttonStyle(.plain).accessibilityLabel("上一时段")
                    Button("今天") { anchor = Date(); selected = nil }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.foreground)
                        .padding(.horizontal, 10).frame(height: 28)
                        .background(Theme.secondary, in: Capsule())
                        .buttonStyle(.plain)
                    Button { move(1) } label: {
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                            .frame(width: 28, height: 28).background(Theme.secondary, in: Circle())
                    }.buttonStyle(.plain).accessibilityLabel("下一时段")
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    filterChip(id: "all", label: "全部")
                    filterChip(id: "running", label: "进行中")
                    filterChip(id: "todo", label: "未开始")
                    filterChip(id: "done", label: "已完成")
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    private func filterChip(id: String, label: String) -> some View {
        let on = filter == id
        let count = filterCount(id)
        return Button { filter = id } label: {
            HStack(spacing: 5) {
                Text(label).font(.system(size: 12.5, weight: on ? .semibold : .medium))
                Text("\(count)").font(.system(size: 11, weight: .medium)).monospacedDigit()
                    .foregroundStyle(on ? Theme.brand : Theme.muted)
            }
            .foregroundStyle(on ? Theme.brand : Theme.foreground)
            .padding(.horizontal, 11).frame(height: 30)
            .background(on ? Theme.brandSoft : Theme.secondary, in: Capsule())
            .overlay(Capsule().strokeBorder(on ? Theme.brand.opacity(0.35) : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: Day View (Status Groups)

    @ViewBuilder private var dayAgenda: some View {
        if filtered.isEmpty {
            if unscheduled.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "calendar").font(.system(size: 28)).foregroundStyle(Theme.muted)
                    Text(query.isEmpty ? "这一天暂时没有匹配的待办" : "没有找到相关待办")
                        .font(.subheadline).foregroundStyle(Theme.muted)
                    Button { editing = TodoItem(date: anchorKey) } label: {
                        Label("安排一件事", systemImage: "plus")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Theme.brand)
                    }
                    .buttonStyle(.plain)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 44)
            }
        } else {
            let statusGroups: [(key: String, title: String, icon: String, tint: Color)] = [
                ("running", "进行中", "arrow.triangle.2.circlepath", Theme.brand),
                ("todo", "未开始", "circle", Theme.muted),
                ("done", "已完成", "checkmark.circle.fill", Theme.success),
            ]
            ForEach(statusGroups, id: \.key) { group in
                let list = filtered.filter { item in
                    group.key == "running" ? (item.status == "running" || item.status == "review") : item.status == group.key
                }
                if !list.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Image(systemName: group.icon).font(.system(size: 12, weight: .semibold)).foregroundStyle(group.tint)
                            Text(group.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.foreground)
                            Text("\(list.count)").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Theme.secondary, in: Capsule())
                        }
                        ForEach(list) { item in todoRow(item) }
                    }
                }
            }
        }
    }

    // MARK: Week Board (7 Columns)

    private var weekBoard: some View {
        let names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
        let board = HStack(alignment: .top, spacing: 8) {
            ForEach(Array(days.enumerated()), id: \.offset) { index, day in
                let key = TodoDates.key(day)
                let isToday = key == todayKey
                let dayItems = filtered.filter { $0.date == key }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 4) {
                        Button { anchor = day; period = "day"; selected = nil } label: {
                            HStack(spacing: 4) {
                                Text(names.indices.contains(index) ? names[index] : "")
                                    .font(.caption2).foregroundStyle(isToday ? Theme.brand : Theme.muted)
                                Text("\(TodoDates.calendar.component(.day, from: day))")
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundStyle(isToday ? Theme.brand : Theme.foreground)
                                if isToday { Circle().fill(Theme.brand).frame(width: 5, height: 5) }
                            }
                        }
                        .buttonStyle(.plain)
                        Spacer(minLength: 0)
                        Button { anchor = day; editing = TodoItem(date: key) } label: {
                            Image(systemName: "plus").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                                .frame(width: 22, height: 22).background(Theme.secondary, in: Circle())
                        }
                        .buttonStyle(.plain).accessibilityLabel("在 \(key) 添加待办")
                    }
                    if dayItems.isEmpty {
                        Text("—").font(.caption).foregroundStyle(Theme.muted.opacity(0.6))
                            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 12)
                    } else {
                        ForEach(dayItems) { item in weekEventCard(item) }
                    }
                    Spacer(minLength: 0)
                }
                .padding(8)
                .frame(minWidth: 118, maxWidth: .infinity, minHeight: 170, alignment: .topLeading)
                .background(isToday ? Theme.brandSoft.opacity(0.45) : Theme.wash, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(isToday ? Theme.brand.opacity(0.35) : Theme.border))
            }
        }
        #if os(macOS)
        return ViewThatFits(in: .horizontal) {
            board
            ScrollView(.horizontal, showsIndicators: true) { board }
        }
        #else
        return ScrollView(.horizontal, showsIndicators: false) { board }
        #endif
    }

    private func weekEventCard(_ item: TodoItem) -> some View {
        let on = selected == item.id
        return Button { selected = item.id } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 4) {
                    statusGlyph(item.status, size: 11)
                    Text(item.statusTitle).font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.muted)
                }
                Text(item.title)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 5) {
                    ownerAvatar(item.owner, size: 18)
                    Spacer(minLength: 0)
                    if item.priority == "高" {
                        Image(systemName: "flag.fill").font(.system(size: 9.5)).foregroundStyle(Theme.danger)
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(on ? Theme.brand : Theme.border, lineWidth: on ? 1.5 : 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: Month Calendar (Event Title Pills + Overflow)

    private var monthCalendar: some View {
        VStack(spacing: 6) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 5), count: 7), spacing: 5) {
                ForEach(["周一", "周二", "周三", "周四", "周五", "周六", "周日"], id: \.self) { label in
                    Text(label).font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity).padding(.bottom, 2)
                }
                ForEach(days, id: \.self) { day in
                    let key = TodoDates.key(day)
                    let isToday = key == todayKey
                    let inMonth = TodoDates.calendar.isDate(day, equalTo: anchor, toGranularity: .month)
                    let dayNum = TodoDates.calendar.component(.day, from: day)
                    let monthNum = TodoDates.calendar.component(.month, from: day)
                    let dayItems = scoped.filter { $0.date == key && $0.matches(filter) }

                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 2) {
                            Button { anchor = day; period = "day"; selected = nil } label: {
                                Text(dayNum == 1 ? "\(monthNum)月1日" : "\(dayNum)")
                                    .font(.system(size: 11.5, weight: isToday ? .bold : .medium))
                                    .foregroundStyle(isToday ? Theme.brand : Theme.foreground)
                            }
                            .buttonStyle(.plain)
                            Spacer(minLength: 0)
                            Button { anchor = day; editing = TodoItem(date: key) } label: {
                                Image(systemName: "plus").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Theme.muted)
                                    .frame(width: 18, height: 18)
                            }
                            .buttonStyle(.plain).accessibilityLabel("在 \(key) 添加待办")
                        }
                        if let first = dayItems.first {
                            Button { selected = first.id } label: {
                                HStack(spacing: 3) {
                                    Circle().fill(statusColor(first.status)).frame(width: 5, height: 5)
                                    Text(first.title).font(.system(size: 10.5)).foregroundStyle(Theme.foreground).lineLimit(1)
                                }
                                .padding(.horizontal, 5).padding(.vertical, 2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.card, in: RoundedRectangle(cornerRadius: 5))
                            }
                            .buttonStyle(.plain)
                        }
                        if dayItems.count > 1 {
                            Button { anchor = day; period = "day"; selected = nil } label: {
                                Text("+\(dayItems.count - 1)")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(Theme.brand)
                            }
                            .buttonStyle(.plain)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(6)
                    .frame(maxWidth: .infinity, minHeight: 74, alignment: .topLeading)
                    .background(isToday ? Theme.brandSoft.opacity(0.45) : Theme.wash, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(isToday ? Theme.brand.opacity(0.4) : Theme.border))
                    .opacity(inMonth ? 1 : 0.45)
                }
            }
        }
    }

    // MARK: Row + Quick Add

    private func todoRow(_ item: TodoItem) -> some View {
        let on = selected == item.id
        let isOverdue = !item.date.isEmpty && item.date < todayKey && item.status != "done"
        let runningAI = item.status == "running" && item.taskId != nil
        return HStack(spacing: 10) {
            Button {
                let targetAction = item.status == "done" ? "reopen" : "complete"
                Task { await act(item, targetAction, nil) }
            } label: {
                statusGlyph(item.status, size: 18)
                    .frame(width: 28, height: 28)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(busy || runningAI)
            .accessibilityLabel("\(item.status == "done" ? "重新打开" : "完成")：\(item.title)")

            Button { selected = item.id } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(item.status == "done" ? Theme.muted : Theme.foreground)
                            .strikethrough(item.status == "done")
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        HStack(spacing: 8) {
                            if item.status == "review" {
                                Text("待验收")
                                    .font(.system(size: 10.5, weight: .semibold))
                                    .foregroundStyle(Theme.approval)
                                    .padding(.horizontal, 6).padding(.vertical, 1)
                                    .background(Theme.approvalSoft, in: Capsule())
                            }
                            if item.priority == "高" {
                                Label("高优先级", systemImage: "flag.fill")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(Theme.danger)
                            }
                            Label(dueText(item.date), systemImage: "calendar")
                                .font(.system(size: 11))
                                .foregroundStyle(isOverdue ? Theme.danger : Theme.muted)
                            if !item.steps.isEmpty {
                                let doneCount = item.steps.filter(\.done).count
                                Label("\(doneCount)/\(item.steps.count)", systemImage: "checklist")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.muted)
                            }
                        }
                    }
                    Spacer(minLength: 6)
                    HStack(spacing: 6) {
                        ownerAvatar(item.owner, size: 24)
                        Text(ownerName(item.owner)).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(on ? Theme.brandSoft.opacity(0.6) : Theme.wash, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(on ? Theme.brand.opacity(0.45) : Theme.border))
    }

    private var quickAddBar: some View {
        let trimmed = quickText.trimmingCharacters(in: .whitespacesAndNewlines)
        return HStack(spacing: 8) {
            Button { editing = TodoItem(date: anchorKey) } label: {
                Image(systemName: "plus").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.muted)
                    .frame(width: 32, height: 32).background(Theme.secondary, in: Circle())
            }
            .buttonStyle(.plain)
            .help("填写完整待办")
            .accessibilityLabel("填写完整待办")

            TextField("添加待办 · \(dueText(anchorKey))", text: $quickText)
                .textFieldStyle(.plain)
                .font(.system(size: 13.5))
                .onSubmit { Task { await addQuick() } }
                .disabled(busy)

            Button { Task { await addQuick() } } label: {
                Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold))
                    .foregroundStyle(!trimmed.isEmpty ? Theme.primaryForeground : Theme.muted)
                    .frame(width: 32, height: 32)
                    .background(!trimmed.isEmpty ? Theme.primary : Theme.secondary, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(busy || trimmed.isEmpty)
            .accessibilityLabel("添加待办")
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
    }

    // MARK: Helpers & Actions

    @ViewBuilder private func statusGlyph(_ status: String, size: CGFloat) -> some View {
        switch status {
        case "running": Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: size)).foregroundStyle(Theme.brand)
        case "review": Image(systemName: "checkmark.circle").font(.system(size: size)).foregroundStyle(Theme.approval)
        case "done": Image(systemName: "checkmark.circle.fill").font(.system(size: size)).foregroundStyle(Theme.success)
        default: Image(systemName: "circle").font(.system(size: size)).foregroundStyle(Theme.muted)
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "running": Theme.brand
        case "review": Theme.approval
        case "done": Theme.success
        default: Theme.muted
        }
    }

    @ViewBuilder private func ownerAvatar(_ owner: String, size: CGFloat) -> some View {
        if owner == "me" {
            Image(systemName: "person.fill").font(.system(size: size * 0.48)).foregroundStyle(Theme.brand)
                .frame(width: size, height: size).background(Theme.brandSoft, in: Circle())
        } else if let bot = workspace.bot(owner) {
            AgentAvatar(appearance: AgentAppearance.of(bot, firstID: workspace.bots.first?.id), size: size)
        } else {
            Image(systemName: "person.fill").font(.system(size: size * 0.48)).foregroundStyle(Theme.muted)
                .frame(width: size, height: size).background(Theme.secondary, in: Circle())
        }
    }

    private func ownerName(_ id: String) -> String {
        id == "me" ? "我" : workspace.bot(id)?.name ?? "已归档 Agent"
    }

    private func dueText(_ date: String) -> String {
        if date.isEmpty { return "无截止日期" }
        if date == todayKey { return "今天" }
        if let tomorrow = TodoDates.calendar.date(byAdding: .day, value: 1, to: Date()), date == TodoDates.key(tomorrow) { return "明天" }
        let parts = date.split(separator: "-")
        if parts.count == 3, let m = Int(parts[1]), let d = Int(parts[2]) { return "\(m)月\(d)日" }
        return date
    }

    private func move(_ amount: Int) {
        anchor = TodoDates.calendar.date(byAdding: period == "month" ? .month : .day, value: amount * (period == "week" ? 7 : 1), to: anchor) ?? anchor
        selected = nil
    }

    private func showToast(_ text: String) {
        toastTask?.cancel()
        toastText = text
        toastTask = Task {
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { toastText = "" }
        }
    }

    private func load() async {
        serial += 1; let current = serial
        do {
            let response: TodoList = try await workspace.client.get("/api/todos")
            if current == serial && workspace.state != nil { items = response.items; loaded = true }
        } catch {
            if current == serial && !Task.isCancelled { errorText = CoreError.wrap(error).message; loaded = true }
        }
    }

    private func addQuick() async {
        let title = quickText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !busy else { return }
        busy = true; errorText = ""
        defer { busy = false }
        var item = TodoItem(date: anchorKey)
        item.title = title
        do {
            let created: TodoItem = try await workspace.client.post("/api/todos/save", body: item)
            quickText = ""
            await load()
            selected = created.id
            showToast("已添加待办")
        } catch {
            errorText = CoreError.wrap(error).message
        }
    }

    private func savePatched(_ patched: TodoItem) async {
        guard !busy else { return }
        busy = true; errorText = ""
        defer { busy = false }
        do {
            let _: TodoItem = try await workspace.client.post("/api/todos/save", body: patched)
            await load()
            showToast("已保存待办")
        } catch {
            errorText = CoreError.wrap(error).message
            await load()
        }
    }

    private func act(_ item: TodoItem, _ action: String, _ feedback: String?) async {
        guard !busy else { return }
        busy = true; errorText = ""
        defer { busy = false }
        do {
            try await workspace.client.post("/api/todos/action", body: TodoAction(item, action: action, feedback: feedback))
            if action == "delete" { selected = nil }
            await load()
            let toast = action == "start" ? "已交给 AI" : action == "stop" ? "正在停止" : action == "delete" ? "已删除待办" : "已更新待办"
            showToast(toast)
        } catch {
            errorText = CoreError.wrap(error).message
            await load()
        }
    }
}

/// Modal editor for creating or editing a Todo item, including clearable due date.
private struct TodoEditorSheet: View {
    let workspace: WorkspaceStore
    let original: TodoItem
    let saved: @MainActor (TodoItem) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft: TodoItem
    @State private var hasDate: Bool
    @State private var busy = false
    @State private var errorText = ""

    init(workspace: WorkspaceStore, original: TodoItem, saved: @escaping @MainActor (TodoItem) async -> Void) {
        self.workspace = workspace; self.original = original; self.saved = saved
        _draft = State(initialValue: original)
        _hasDate = State(initialValue: !original.date.isEmpty)
    }

    private var lockedOwner: Bool { original.version > 0 && original.status == "running" && original.taskId != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section("基本内容") {
                    TextField("要做什么（例如：整理这周的项目进展）", text: $draft.title)
                    TextEditor(text: $draft.description)
                        .frame(minHeight: 90, maxHeight: 160)
                }
                Section("安排") {
                    Picker("交给谁", selection: $draft.owner) {
                        Text("我").tag("me")
                        ForEach(workspace.bots) { bot in Text(bot.name).tag(bot.id) }
                    }
                    .disabled(lockedOwner)
                    Toggle("设置截止日期", isOn: $hasDate)
                        .onChange(of: hasDate) { _, on in
                            if on && draft.date.isEmpty { draft.date = TodoDates.key(Date()) }
                            else if !on { draft.date = "" }
                        }
                    if hasDate {
                        DatePicker("截止日期", selection: Binding(
                            get: { TodoDates.parse(draft.date) ?? Date() },
                            set: { draft.date = TodoDates.key($0) }
                        ), displayedComponents: .date)
                    }
                    Picker("优先级", selection: $draft.priority) {
                        Text("高").tag("高")
                        Text("普通").tag("普通")
                        Text("低").tag("低")
                    }
                    .pickerStyle(.segmented)
                }
                if !errorText.isEmpty {
                    Section { Text(errorText).font(.caption).foregroundStyle(Theme.danger) }
                }
            }
            .navigationTitle(original.version == 0 ? "新建待办" : "编辑待办")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "保存中…" : "保存") { Task { await save() } }
                        .disabled(busy || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 440, idealWidth: 500, minHeight: 420)
        #endif
        .interactiveDismissDisabled(busy)
    }

    private func save() async {
        guard !busy else { return }
        busy = true; errorText = ""
        defer { busy = false }
        var body = draft
        body.title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !hasDate { body.date = "" }
        do {
            let updated: TodoItem = try await workspace.client.post("/api/todos/save", body: body)
            await saved(updated)
            dismiss()
        } catch {
            errorText = CoreError.wrap(error).message
        }
    }
}

/// Interactive detail panel (Mac right split sidebar / iOS sheet) with inline edits, interactive checklist,
/// delivery card, failed-task banner, and exact Web footer actions.
private struct TodoDetailsPane: View {
    let workspace: WorkspaceStore
    let item: TodoItem
    let busy: Bool
    let error: String
    let ownerName: (String) -> String
    let onAction: @MainActor (String, String?) async -> Void
    let onPatch: @MainActor (TodoItem) async -> Void
    let onEdit: () -> Void
    let onClose: () -> Void
    let onOpenAgent: () -> Void

    @State private var feedback = ""
    @State private var revising = false
    @State private var showingResult = false
    @State private var deleting = false

    private var lockedByAI: Bool { item.status == "running" && item.taskId != nil }
    private var failedTaskStatus: String? {
        guard item.status == "todo", let s = item.taskStatus, ["failed", "rejected", "cancelled"].contains(s) else { return nil }
        return s
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(item.statusTitle)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(Theme.brand)
                    .padding(.horizontal, 9).padding(.vertical, 3)
                    .background(Theme.brandSoft, in: Capsule())
                Spacer()
                Button { deleting = true } label: {
                    Image(systemName: "trash").font(.system(size: 13)).foregroundStyle(Theme.danger)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain).disabled(busy).accessibilityLabel("删除待办")
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain).accessibilityLabel("关闭详情")
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            Divider().overlay(Theme.border)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Button(action: onEdit) {
                        Text(item.title)
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(Theme.foreground)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .disabled(busy || lockedByAI)

                    // Inline property controls
                    VStack(spacing: 10) {
                        HStack {
                            Label("负责人", systemImage: "person").font(.caption).foregroundStyle(Theme.muted)
                            Spacer()
                            Picker("负责人", selection: Binding(
                                get: { item.owner },
                                set: { next in
                                    guard next != item.owner else { return }
                                    var copy = item; copy.owner = next
                                    Task { await onPatch(copy) }
                                }
                            )) {
                                Text("我").tag("me")
                                ForEach(workspace.bots) { bot in Text(bot.name).tag(bot.id) }
                            }
                            .labelsHidden().pickerStyle(.menu).disabled(busy || lockedByAI)
                        }
                        Divider().overlay(Theme.border)
                        HStack {
                            Label("截止日期", systemImage: "calendar").font(.caption).foregroundStyle(Theme.muted)
                            Spacer()
                            if item.date.isEmpty {
                                Button("设置日期") {
                                    var copy = item; copy.date = TodoDates.key(Date())
                                    Task { await onPatch(copy) }
                                }
                                .font(.caption.weight(.medium)).foregroundStyle(Theme.brand).buttonStyle(.plain)
                                .disabled(busy || lockedByAI)
                            } else {
                                DatePicker("截止日期", selection: Binding(
                                    get: { TodoDates.parse(item.date) ?? Date() },
                                    set: { next in
                                        let key = TodoDates.key(next)
                                        guard key != item.date else { return }
                                        var copy = item; copy.date = key
                                        Task { await onPatch(copy) }
                                    }
                                ), displayedComponents: .date)
                                .labelsHidden().controlSize(.small).disabled(busy || lockedByAI)
                                Button {
                                    var copy = item; copy.date = ""
                                    Task { await onPatch(copy) }
                                } label: {
                                    Image(systemName: "xmark.circle.fill").font(.caption).foregroundStyle(Theme.muted)
                                }
                                .buttonStyle(.plain).disabled(busy || lockedByAI).help("清除截止日期")
                            }
                        }
                        Divider().overlay(Theme.border)
                        HStack {
                            Label("优先级", systemImage: "flag").font(.caption).foregroundStyle(Theme.muted)
                            Spacer()
                            Picker("优先级", selection: Binding(
                                get: { item.priority },
                                set: { next in
                                    guard next != item.priority else { return }
                                    var copy = item; copy.priority = next
                                    Task { await onPatch(copy) }
                                }
                            )) {
                                Text("高").tag("高"); Text("普通").tag("普通"); Text("低").tag("低")
                            }
                            .labelsHidden().pickerStyle(.menu).disabled(busy || lockedByAI)
                        }
                    }
                    .padding(12)
                    .background(Theme.wash, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("完成要求").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                            Spacer()
                            Button("编辑", action: onEdit)
                                .font(.caption.weight(.medium)).foregroundStyle(Theme.brand).buttonStyle(.plain)
                                .disabled(busy || lockedByAI)
                        }
                        Text(item.description.isEmpty ? "还没有添加说明" : item.description)
                            .font(.system(size: 13.5))
                            .foregroundStyle(item.description.isEmpty ? Theme.muted : Theme.foreground)
                            .textSelection(.enabled)
                    }

                    if !item.steps.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("步骤").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                                Spacer()
                                Text("\(item.steps.filter(\.done).count) / \(item.steps.count)").font(.caption2).foregroundStyle(Theme.muted)
                            }
                            ForEach(Array(item.steps.enumerated()), id: \.offset) { index, step in
                                Button {
                                    var copy = item
                                    copy.steps[index].done.toggle()
                                    Task { await onPatch(copy) }
                                } label: {
                                    HStack(alignment: .top, spacing: 8) {
                                        Image(systemName: step.done ? "checkmark.square.fill" : "square")
                                            .foregroundStyle(step.done ? Theme.brand : Theme.muted)
                                        Text(step.text)
                                            .font(.system(size: 13))
                                            .foregroundStyle(step.done ? Theme.muted : Theme.foreground)
                                            .strikethrough(step.done)
                                            .multilineTextAlignment(.leading)
                                        Spacer(minLength: 0)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .disabled(busy || lockedByAI)
                            }
                        }
                        .padding(12)
                        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }

                    if (item.status == "review" || item.status == "done"), !item.result.isEmpty {
                        Button { showingResult = true } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "doc.text.fill").font(.title3).foregroundStyle(Theme.brand)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.result.split(separator: "\n").first.map(String.init) ?? item.title)
                                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.foreground).lineLimit(1)
                                    Text(item.status == "done" ? "已确认完成 · 查看交付内容" : "已完成，等你看看 · 查看交付内容")
                                        .font(.caption2).foregroundStyle(Theme.muted)
                                }
                                Spacer(minLength: 4)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.muted)
                            }
                            .padding(12)
                            .background(Theme.brandSoft.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }

                    if lockedByAI {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(ToolLabels.statusText(item.taskStatus ?? "running")).font(.caption.weight(.medium))
                            Spacer()
                            Button("打开对话与审批", action: onOpenAgent)
                                .font(.caption.weight(.semibold)).foregroundStyle(Theme.brand).buttonStyle(.plain)
                        }
                        .padding(12)
                        .background(Theme.brandSoft.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }

                    if let failedStatus = failedTaskStatus {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("上次执行：\(ToolLabels.statusText(failedStatus))")
                                .font(.caption.weight(.semibold)).foregroundStyle(Theme.danger)
                            if !item.result.isEmpty {
                                Text(item.result).font(.caption).foregroundStyle(Theme.muted).textSelection(.enabled)
                            }
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }

                    if revising && item.status == "review" {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("告诉 AI 要调整什么").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                            TextField("例如：补充每项工作的下一步安排", text: $feedback, axis: .vertical)
                                .lineLimit(2...5).textFieldStyle(.roundedBorder)
                            HStack(spacing: 8) {
                                Button("提交修改要求") {
                                    let text = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
                                    guard !text.isEmpty else { return }
                                    Task {
                                        await onAction("start", text)
                                        feedback = ""; revising = false
                                    }
                                }
                                .buttonStyle(ConversationActionButtonStyle(size: .compact))
                                .disabled(busy || feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                Button("取消") { feedback = ""; revising = false }
                                    .font(.caption).foregroundStyle(Theme.muted).buttonStyle(.plain)
                            }
                        }
                        .padding(12)
                        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }

                    if !item.log.isEmpty {
                        DisclosureGroup("动态记录 (\(item.log.count))") {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(Array(item.log.enumerated()), id: \.offset) { _, entry in
                                    Text(entry).font(.caption).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                            .padding(.top, 6)
                        }
                        .font(.caption.weight(.semibold)).tint(Theme.muted)
                    }

                    if !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(Theme.danger).textSelection(.enabled)
                    }
                }
                .padding(16)
            }

            Divider().overlay(Theme.border)
            footerActions
                .padding(14)
        }
        .onChange(of: item.id) { _, _ in feedback = ""; revising = false }
        .confirmationDialog("删除这条待办？", isPresented: $deleting, titleVisibility: .visible) {
            Button("删除", role: .destructive) { Task { await onAction("delete", nil) } }
            Button("取消", role: .cancel) {}
        } message: {
            Text(item.title)
        }
        .sheet(isPresented: $showingResult) {
            NavigationStack {
                ScrollView {
                    MarkdownText(source: item.result)
                        .padding(20)
                }
                .navigationTitle("交付内容")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("关闭") { showingResult = false } }
                }
            }
            #if os(macOS)
            .frame(minWidth: 460, idealWidth: 560, minHeight: 380)
            #endif
        }
    }

    @ViewBuilder private var footerActions: some View {
        HStack(spacing: 10) {
            if item.status == "review" {
                Button("继续修改") { revising.toggle() }
                    .buttonStyle(ConversationActionButtonStyle(tone: .dark))
                Button("确认完成") { Task { await onAction("complete", nil) } }
                    .buttonStyle(ConversationActionButtonStyle())
            } else if item.status == "running" && item.taskId == nil {
                Button("暂停处理") { Task { await onAction("stop", nil) } }
                    .buttonStyle(ConversationActionButtonStyle(tone: .dark))
                Button("标记完成") { Task { await onAction("complete", nil) } }
                    .buttonStyle(ConversationActionButtonStyle())
            } else if item.status == "running" {
                Button("停止执行") { Task { await onAction("stop", nil) } }
                    .buttonStyle(ConversationActionButtonStyle(tone: .dark))
            } else if item.status == "done" {
                Button("重新打开") { Task { await onAction("reopen", nil) } }
                    .buttonStyle(ConversationActionButtonStyle(tone: .dark))
            } else if item.owner == "me" {
                Button("开始处理") { Task { await onAction("begin", nil) } }
                    .buttonStyle(ConversationActionButtonStyle(tone: .dark))
                Button("标记完成") { Task { await onAction("complete", nil) } }
                    .buttonStyle(ConversationActionButtonStyle())
            } else {
                Button("交给 \(ownerName(item.owner))") { Task { await onAction("start", nil) } }
                    .buttonStyle(ConversationActionButtonStyle())
            }
            Spacer(minLength: 0)
            if busy { ProgressView().controlSize(.small) }
        }
        .disabled(busy)
    }
}
