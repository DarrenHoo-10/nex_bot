import SwiftUI
import NexClientKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The centred row previews the assistant. The conversation changes only when a row is chosen.
struct AssistantSwitcher: View {
    let workspace: WorkspaceStore
    let selectedID: String
    let choose: (String) -> Void
    @State private var centered: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(iOS)
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    #endif

    private let rowHeight: CGFloat = 44
    private let copies = 9
    private var assistants: [Bot] { workspace.bots }
    private var count: Int { assistants.count }
    private var middle: Int { (copies / 2) * count }
    private var visibleRows: Int {
        #if os(macOS)
        let limit = Int(((NSScreen.main?.visibleFrame.height ?? 600) - 160) / rowHeight)
        #else
        let limit = verticalSizeClass == .compact ? 4 : 9
        #endif
        return min(count, max(1, limit))
    }
    private var leadingRows: Int { (visibleRows - 1) / 2 }
    private var fittingWidth: CGFloat {
        #if os(macOS)
        let font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        #else
        let font = UIFont.systemFont(ofSize: 14, weight: .semibold)
        #endif
        let nameWidth = assistants.map { ($0.name as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        return min(240, ceil(nameWidth) + 56)
    }

    var body: some View {
        Group {
            if count == 1, let assistant = assistants.first {
                option(assistant, highlighted: true)
            } else if count > 1 {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(0..<(copies * count), id: \.self) { index in
                            let distance = index - (centered ?? initialRow)
                            option(assistants[index % count], highlighted: distance == 0)
                                .accessibilityHidden(distance < -(count - 1) / 2 || distance > count / 2)
                                .id(index)
                        }
                    }
                    .scrollTargetLayout()
                }
                .contentMargins(.top, rowHeight * CGFloat(leadingRows), for: .scrollContent)
                .contentMargins(.bottom, rowHeight * CGFloat(visibleRows - leadingRows - 1), for: .scrollContent)
                .scrollIndicators(.hidden)
                .scrollTargetBehavior(.viewAligned)
                .scrollPosition(id: $centered, anchor: UnitPoint(x: 0.5, y: CGFloat(leadingRows) / CGFloat(max(1, visibleRows - 1))))
                .frame(height: rowHeight * CGFloat(visibleRows))
                .onAppear { centered = initialRow }
                .task(id: centered) {
                    guard let index = centered, index < count || index >= (copies - 1) * count else { return }
                    do { try await Task.sleep(for: .milliseconds(220)) } catch { return }
                    guard count > 1 else { return }
                    centered = middle + index % count
                }
                .accessibilityScrollAction { direction in
                    switch direction {
                    case .top: move(-1)
                    case .bottom: move(1)
                    default: break
                    }
                }
            }
        }
        .frame(width: fittingWidth)
        .padding(4)
        .accessibilityLabel("切换助手")
    }

    private var initialRow: Int { middle + (assistants.firstIndex { $0.id == selectedID } ?? 0) }

    private func move(_ amount: Int) {
        guard count > 1 else { return }
        let current = centered ?? initialRow
        let next = (current + amount + count) % count
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
            centered = current + amount < 0 || current + amount >= copies * count ? middle + next : current + amount
        }
    }

    private func option(_ assistant: Bot, highlighted: Bool) -> some View {
        Button { choose(assistant.id) } label: {
            HStack(spacing: 8) {
                AgentAvatar(appearance: .of(assistant, firstID: assistants.first?.id), size: 30).accessibilityHidden(true)
                Text(assistant.name).font(.system(size: 14, weight: .semibold)).lineLimit(1)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: rowHeight)
            .background(highlighted ? Theme.wash : Color.clear, in: RoundedRectangle(cornerRadius: 11))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(assistant.id == selectedID ? .isSelected : [])
    }
}
