import SwiftUI
import NexClientKit

/// One additive catalog on both Apple clients. Descriptions are for VoiceOver only.
struct RoleAvatarOptions: View {
    @Binding var choice: AgentAppearance
    var columns = 4
    private var shape: String { if case .companion(let s, _) = choice { s } else { "soft" } }
    private var color: String { if case .companion(_, let c) = choice { c } else { "teal" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("角色").font(.subheadline.weight(.semibold))
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: columns), spacing: 10) {
                ForEach(AvatarCatalog.graphics) { item in
                    option(.graphic(item.id), label: item.description, size: 54)
                        .accessibilityIdentifier("graphic-\(item.id)")
                }
            }
            Divider().overlay(Theme.border)
            HStack(spacing: 8) {
                ForEach(AvatarCatalog.shapes) { item in
                    option(.companion(shape: item.id, color: color), label: "轮廓 \(item.name)", size: 36)
                }
            }
            HStack(spacing: 12) {
                ForEach(AvatarCatalog.colors) { item in
                    Button { choice = .companion(shape: shape, color: item.id) } label: {
                        Circle().fill(Color(hex: item.hex)).frame(width: 26, height: 26)
                            .overlay {
                                if case .companion(_, let c) = choice, c == item.id {
                                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                                }
                            }
                            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityLabel("颜色 \(item.name)")
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 5), spacing: 6) {
                ForEach(0..<20, id: \.self) { index in
                    let s = AvatarCatalog.shapes[index / 5], c = AvatarCatalog.colors[index % 5]
                    option(.companion(shape: s.id, color: c.id), label: AvatarCatalog.companionName(shape: s.id, color: c.id), size: 32)
                }
            }
        }
    }

    private func option(_ value: AgentAppearance, label: String, size: CGFloat) -> some View {
        let selected = choice == value
        return Button { choice = value } label: {
            AgentAvatar(appearance: value, size: size)
                .frame(maxWidth: .infinity).frame(height: size + 16)
                .background(selected ? Theme.brandSoft : Theme.card.opacity(0.65), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(selected ? Theme.identityAccent : Theme.border, lineWidth: selected ? 2 : 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
