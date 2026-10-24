# NexBot Core 0.9.0 — independent backend service


Core runs under Node.js 24+ on the backend host. It has no Electron window,
tray, desktop login storage, bundled Hindsight/Python/PostgreSQL or ML weights.
Use a native build for the target OS/CPU because the PDF runtime includes a
platform-specific canvas module. Mac and Windows clients use the same thin
shell and connect to this service.

## First startup

Extract the service archive into a program directory. Choose a separate private
data directory owned by the service account:

```sh
node core/service.js init --data-dir=/your/private/nexbot-data
node core/service.js start --data-dir=/your/private/nexbot-data
```

On Windows, substitute a Windows path such as `C:\NexBotData`. `init` prompts
for the NexorAI email/password with the password masked, binds the account and
logs out its temporary initialization session. It does not save the password.
Only this local command can perform first association. A remote client cannot
claim an uninitialized Core. Subsequent clients sign into the same linked
account by default. Enable account workspaces below to accept other accounts
without granting access to the original workspace.

## Independent account workspaces

Set `NEX_CORE_ACCOUNT_WORKSPACES=1` (or pass `--account-workspaces` to `start`).
The original account keeps its existing data and sessions. After verified
NexorAI login, each additional issuer/subject gets a separate database under
`account-workspaces/` within the data directory. New accounts start empty;
model credentials, memory plugin credentials and MCP grants are not copied.
The public endpoint Core ID remains stable for existing thin clients, while
each workspace has a distinct internal ID and a distinct HMAC-derived vault
key. Back up the **entire data directory and original vault key together**.

Hosted account mode disables execution on the service host for all accounts.
Accounts may pair their own independent execution nodes; client sessions and
node credentials never select another account's workspace. Internal workspace
servers do not open additional listening ports. This version supports up to
100 additional workspaces and retains their background schedulers while the
service runs. It is not OS-container isolation for untrusted server plugins;
Core only runs its reviewed built-in broker tools.

Startup prints a ready JSON object containing the local address, PID, Core ID
and initialization state. No credential or bootstrap token is printed. The
default listener is `127.0.0.1:8799`. Stop with Ctrl-C or SIGTERM. The service
closes its workers, database and sockets, then releases its data-directory lock.
Another service or `init` invocation cannot open that directory concurrently.
A configured port collision fails startup explicitly; the service does not
silently choose a different port.

For controlled automation, `init --input-json` reads an `account`/`password`
object from standard input. Do not put the password in arguments or retain
the input in a script, log or shared file.

## Configuration

Optional Gmail connections use `NEX_GOOGLE_CLIENT_ID`,
`NEX_GOOGLE_CLIENT_SECRET` and `NEX_GOOGLE_REDIRECT_URI`, supplied privately to
the Core process. Enable the Gmail API, configure Google's consent screen and
create a Web application OAuth client. Register the exact callback
`https://YOUR-CORE-HOST/api/connectors/oauth/google/callback` and use it as the
redirect variable. After restarting, use Settings → Connectors → Gmail and grant
tools to selected Agents. This version requests only `gmail.readonly` for search,
message and thread reading. Never place these credentials in the checkout or
release archive. See the repository's `docs/verification/gmail-connectors.md` for
Google verification requirements, development setup and isolated test evidence.

| Environment variable | Meaning |
| --- | --- |
| `NEX_CORE_DATA_DIR` | Private data directory; default `~/.nexbot/core` |
| `NEX_CORE_HOST` | `127.0.0.1` by default; `0.0.0.0` or `::1` also supported |
| `NEX_CORE_PORT` | HTTP port, default `8799` |
| `NEX_CORE_PUBLIC_ORIGIN` | Exact external HTTPS root origin behind a reverse proxy |
| `NEX_CORE_VAULT_KEY` | Optional Base64 encoding of a 32-byte vault key |

The corresponding command options are `--data-dir=`, `--host=`, `--port=` and
`--public-origin=`. Otherwise Core creates a private `vault-key.bin` in the data
directory. Back up the data and the key together. Windows deployments should
limit the directory ACL to the service account. An environment-provided key
must remain unchanged across restarts. Neither the key nor the data directory
belongs inside the application archive or source repository.

The user-center issuer is fixed to `https://user.nexorai.com.cn`; production
startup does not accept a replacement issuer or an account-login bypass.
Fixtures can use an explicit loopback issuer only in an owned temporary
directory. They are for development verification, not deployment settings.

## Remote access and clients

Expose Core through an HTTPS reverse proxy. Prefer keeping Core on loopback
when the proxy runs on the same host. Set `NEX_CORE_PUBLIC_ORIGIN` to that exact
HTTPS origin so Host, cookie and login checks use the published address. Plain
HTTP account login is allowed only for same-host loopback connections.

Install NexBot Client, enter the backend URL and sign into the linked NexorAI
account. The client keeps only encrypted login credentials and browser-shell
state. It loads UI from Core and includes no Agent/Pi runtime, database, PDF
engine, local terminal or Device Node. Closing it does not stop the backend.
Account logout revokes that session. Other valid clients remain independent.

Models and memory plugins are configured in Settings after login; their
credentials are stored in Core's encrypted vault. The external Hindsight
plugin is independently deployed and configured. Saved plugin changes apply
when the backend service restarts. Closing a client never stops that service.

## Deployment management

Run `node /program/path/core/service.js start` under the platform's service
manager using a dedicated account and the configuration above. On macOS this
can be a launchd job; on Windows use an existing Node service wrapper or a
scheduled task. Core itself does not install or alter system services.
Native Windows window automation, if used, requires an appropriate interactive
user session; a service running in session 0 is not qualified for desktop input.

Core registers its own backend host as a device. Reading a directory or running
terminal commands acts on that host, not on the client's computer. Other
devices require independent execution nodes; those nodes are not bundled into
the thin client.

## Existing data

Stop the old desktop application and keep its profile plus a backup. To reuse an existing Core, supply its original
Core data directory and 32-byte vault key; copying SQLite alone cannot decrypt
existing credentials. The former desktop's OS-encrypted vault key requires an
explicit export/migration. This release does not automatically read, delete or
migrate a live desktop profile. Embedded Hindsight data is migrated separately
into the external service before enabling that plugin.
