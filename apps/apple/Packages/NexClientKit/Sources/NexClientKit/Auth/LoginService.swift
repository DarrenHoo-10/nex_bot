import Foundation

/// An authenticated link to a Core.
public struct Connection: Sendable {
    public let credential: StoredCredential
    public let client: CoreClient
    public var origin: CoreOrigin { client.origin }
}

/// What the login form needs before the user types anything.
public struct ConnectionDefaults: Sendable, Equatable {
    public var origin: String
    public var name: String
    /// A saved login exists and can be resumed.
    public var hasSavedLogin: Bool
}

/// Discover, login, resume and logout, with the same rules as the Electron shell.
public actor LoginService {
    private let store: CredentialStore
    private let session: URLSession
    private let defaultOrigin: CoreOrigin
    private let overrideOrigin: CoreOrigin?
    private var saved: StoredCredential?
    private var repointed = false
    private var loaded = false

    public init(store: CredentialStore, session: URLSession = CoreClient.makeSession(), defaultOrigin: CoreOrigin = .default, overrideOrigin: CoreOrigin? = nil) {
        self.store = store; self.session = session; self.defaultOrigin = defaultOrigin; self.overrideOrigin = overrideOrigin
    }

    /// Loads the saved login and applies an explicit origin override (which forces identity verification on resume).
    public func bootstrap(deviceName: String) -> ConnectionDefaults {
        if !loaded { loaded = true; saved = try? store.load() }
        if var s = saved, let o = overrideOrigin, s.origin != o.string {
            s.origin = o.string; saved = s; repointed = true
            try? store.save(s)
        }
        return ConnectionDefaults(origin: saved?.origin ?? overrideOrigin?.string ?? defaultOrigin.string, name: saved?.name.nonEmpty ?? deviceName, hasSavedLogin: saved != nil)
    }

    public var hasSavedLogin: Bool { saved != nil }

    private func client(_ origin: CoreOrigin, token: String? = nil) -> CoreClient { CoreClient(origin: origin, token: token, session: session) }

    /// Fetches the identity and checks everything a password login needs, in Electron's order.
    public func discover(origin: CoreOrigin) async throws -> ClientIdentity {
        let identity = try await client(origin).identity()
        try Task.checkCancellation()
        guard identity.version == 1, !identity.coreId.isEmpty else { throw CoreError(kind: .unsupported, message: "Core 不支持客户端协议 v1") }
        guard origin.allowsPasswordLogin else { throw CoreError(kind: .unsupported, message: "账号登录需要 HTTPS 后端地址，请为服务配置 HTTPS 连接") }
        guard identity.loginRequired, identity.loginMethods.contains("password") else { throw CoreError(kind: .unsupported, message: "后端须启用 NexorAI 账号登录") }
        guard identity.initialized else { throw CoreError(kind: .unsupported, message: "后端尚未关联账号，请先在服务器运行 init 完成初始化") }
        return identity
    }

    /// Password login; saves the credential on success.
    public func login(origin originText: String, name: String, account: String, password: String) async throws -> Connection {
        do {
            let origin = try CoreOrigin(originText.isEmpty ? defaultOrigin.string : originText)
            let identity = try await discover(origin: origin)
            let http = client(origin)
            let transaction: LoginTransaction = try await http.post("/api/auth/start", body: StartBody(account: account, name: name))
            let granted: LoginSession = try await http.post("/api/auth/respond", body: RespondBody(transaction: transaction, password: password))
            try Task.checkCancellation()
            guard granted.coreId == identity.coreId else { throw CoreError.identityChanged("Core 身份在登录期间发生变化") }
            let credential = StoredCredential(origin: origin.string, name: name, token: granted.token, coreId: granted.coreId, sessionId: granted.sessionId, expiresAt: granted.expiresAt)
            do { try store.save(credential) } catch {
                // Never leave an issued session behind that this device can no longer revoke.
                try? await client(origin, token: granted.token).post("/api/auth/logout", body: EmptyBody())
                throw error
            }
            saved = credential
            return Connection(credential: credential, client: client(origin, token: granted.token))
        } catch { throw CoreError.wrap(error) }
    }

    /// Resumes the saved login. 401/403/409 delete the credential. A re-pointed or plain-HTTP origin must prove its Core ID first.
    public func resume() async throws -> Connection {
        let old = saved
        do {
            let origin = try CoreOrigin(old?.origin ?? defaultOrigin.string)
            if repointed || !origin.isHTTPS {
                let identity = try await client(origin).identity()
                try Task.checkCancellation()
                guard identity.version == 1, !identity.coreId.isEmpty else { throw CoreError(kind: .unsupported, message: "Core 不支持客户端协议 v1") }
                guard let old, old.coreId == identity.coreId, identity.loginRequired else { throw CoreError.identityChanged("Core 身份已变化，请重新登录") }
            }
            guard let old else { throw CoreError.identityChanged("Core 身份已变化，请重新登录") }
            let check: SessionCheck = try await client(origin).post("/api/session", body: SessionBody(token: old.token))
            try Task.checkCancellation()
            guard check.authenticated, check.coreId == old.coreId else { throw CoreError.identityChanged("Core 身份或登录状态不匹配") }
            var credential = old
            if let e = check.expiresAt { credential.expiresAt = e }
            return Connection(credential: credential, client: client(origin, token: old.token))
        } catch {
            let wrapped = CoreError.wrap(error)
            if wrapped.invalidatesCredential { forget() }
            throw wrapped
        }
    }

    /// Best-effort server logout, then deletes the credential.
    public func logout() async {
        if let s = saved, let origin = try? CoreOrigin(s.origin) {
            try? await client(origin, token: s.token).post("/api/auth/logout", body: EmptyBody())
        }
        forget()
    }

    /// Deletes the saved credential without contacting Core.
    public func forget() {
        try? store.delete()
        saved = nil
    }
}

extension String { var nonEmpty: String? { isEmpty ? nil : self } }
