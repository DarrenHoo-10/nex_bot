import SwiftUI

enum QAvatarCatalog {
    static let ids = ["blue-maid", "orange-flower", "white-dragon", "purple-cat", "gold-bat"]
    static let names = ["blue-maid": "deepseek", "orange-flower": "claude", "white-dragon": "gpt", "purple-cat": "gemini", "gold-bat": "grok"]
}

private struct QSpriteSheet: Decodable {
    let file: String
    let width: Double
    let height: Double
    let frames: [[Double]]
    let idleColumn: Int?
}
private struct QSpriteAtlas: Decodable {
    let idle: QSpriteSheet
    let characters: [String: QSpriteSheet]
    static let bundled: QSpriteAtlas? = {
        guard let url = Bundle.main.url(forResource: "character-sprites", withExtension: "json"), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(QSpriteAtlas.self, from: data)
    }()
}
private struct QSpritePose {
    let file: String
    let sheet: CGSize
    let source: CGRect
    let target: CGRect
    let key: String
}

/// The Web atlases and task poses, with no random-gesture timer.
struct QAvatarBody: View {
    let id: String
    let state: CompanionState
    let size: CGFloat
    let animated: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var clockState = ""
    @State private var clock: Double = 0
    private var elapsed: Double { clockState == "\(id):\(state.rawValue)" ? clock : 0 }
    private var moving: Bool { animated && !reduceMotion && scenePhase == .active }
    private var portrait: Bool { size <= 48 }

    var body: some View {
        Group {
            if let pose = pose {
                QSpriteImage(pose: pose, size: size)
                    .id(pose.key).transition(.opacity)
                    .animation(moving ? .easeOut(duration: 0.12) : nil, value: pose.key)
            }
        }
        .frame(width: size, height: size)
        .background(portrait ? Color(hex: 0xF6F2E9) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: portrait ? size / 2 : 0))
        .task(id: "\(id):\(state.rawValue):\(moving)") {
            clock = 0; clockState = "\(id):\(state.rawValue)"
            guard moving else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(80)) } catch { return }
                clock += 80
            }
        }
    }

    private var pose: QSpritePose? {
        if id == "blue-maid" { return bluePose }
        guard let atlas = QSpriteAtlas.bundled, let character = atlas.characters[id], let column = character.idleColumn else { return nil }
        let group: Int = switch state { case .thinking: 1; case .working: 2; case .approval: 5; case .done: 3; case .failed: 4; default: -1 }
        let idle = group < 0 || ((state == .done || state == .failed) && elapsed >= 2400)
        let phase = elapsed.truncatingRemainder(dividingBy: 6000)
        let blink = phase < 5400 ? 0 : phase < 5500 ? 1 : phase < 5620 ? 2 : phase < 5720 ? 1 : 0
        let frame = idle ? column + blink * 5 : group * 2 + (elapsed >= 650 ? 1 : 0)
        let sheet = idle ? atlas.idle : character
        let r = sheet.frames[frame], rest = atlas.idle.frames[column]
        let scale = idle ? 1 : rest[3] / character.frames[0][3]
        let side = rest[2] * 0.68 / scale
        let source = portrait ? CGRect(x: r[0] + (r[2] - side) / 2, y: r[1], width: side, height: side) : CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
        let target = portrait ? CGRect(x: 0, y: 0, width: 370, height: 370) : CGRect(x: (370-r[2]*scale)/2, y: 365-r[3]*scale, width: r[2]*scale, height: r[3]*scale)
        return QSpritePose(file: "cast/\(sheet.file)", sheet: CGSize(width: sheet.width, height: sheet.height), source: source, target: target, key: "\(id):\(idle):\(frame)")
    }

    private var bluePose: QSpritePose {
        var action: Int = switch state { case .thinking: 2; case .working: 6; case .approval: 12; case .done: 9; case .failed: 11; default: 0 }
        let sequences: [Int: [(Int, Double)]] = [
            0: [(0,2900),(1,85),(2,110),(1,85),(0,1600)],
            2: [(0,1300),(1,450),(2,900),(3,1800)],
            6: [(0,650),(1,350),(3,600),(1,350),(2,250),(3,900)],
            9: [(0,350),(1,450),(2,850),(3,1000)],
            11: [(0,450),(1,550),(2,700),(3,1000)],
            12: [(0,500),(1,600),(2,800),(3,1400)]
        ]
        let duration = sequences[action]!.reduce(0) { $0 + $1.1 }
        if ![0,2,6].contains(action) && elapsed >= duration { action = 0 }
        let sequence = sequences[action]!
        var time = (action == 0 && state != .idle ? 0 : elapsed).truncatingRemainder(dividingBy: sequence.reduce(0) { $0 + $1.1 })
        var column = 0
        for (frame, ms) in sequence { if time < ms { column = frame; break }; time -= ms }
        let index = action < 4 ? 0 : action < 8 ? 1 : action < 11 ? 2 : 3
        let row = action - [0,4,8,11][index]
        let widths: [Double] = [1254,1254,1447,1448], heights: [Double] = [1254,1254,1087,1086]
        let rows: [Double] = [4,4,3,3]
        let files = ["actions-alpha.png","actions-daily-alpha.png","actions-success-v2-alpha.png","actions-recovery-alpha.png"]
        let cell = widths[index]/4, top = index == 2 ? [0.0,354,700][row] : Double(row)*heights[index]/rows[index]
        let source = CGRect(x: Double(column)*cell + (portrait ? cell*0.12 : 0), y: top, width: cell*(portrait ? 0.76 : 1), height: cell*(portrait ? 0.76 : 1))
        return QSpritePose(file: "blue-q/\(files[index])", sheet: CGSize(width: widths[index],height: heights[index]), source: source, target: CGRect(x: 0,y: 0,width: 370,height: 370), key: "blue:\(action):\(column)")
    }
}

@MainActor private enum QSpriteCache {
    static var images: [String: Image] = [:]
    static func image(_ file: String) -> Image? {
        if let cached = images[file] { return cached }
        guard let url = Bundle.main.url(forResource: file, withExtension: nil, subdirectory: "companions") else { return nil }
        #if os(macOS)
        guard let bitmap = NSImage(contentsOf: url) else { return nil }
        let image = Image(nsImage: bitmap)
        #else
        guard let bitmap = UIImage(contentsOfFile: url.path) else { return nil }
        let image = Image(uiImage: bitmap)
        #endif
        images[file] = image; return image
    }
}
private struct QSpriteImage: View {
    let pose: QSpritePose
    let size: CGFloat
    var body: some View {
        let unit = size / 370
        let scale = pose.target.width * unit / pose.source.width
        ZStack(alignment: .topLeading) {
            if let image = QSpriteCache.image(pose.file) {
                image.resizable().interpolation(.high)
                    .frame(width: pose.sheet.width * scale, height: pose.sheet.height * scale)
                    .offset(x: -pose.source.minX * scale, y: -pose.source.minY * scale)
                    .frame(width: pose.target.width * unit, height: pose.target.height * unit, alignment: .topLeading).clipped()
                    .offset(x: pose.target.minX * unit, y: pose.target.minY * unit)
            }
        }.frame(width: size,height: size,alignment: .topLeading).clipped()
    }
}
