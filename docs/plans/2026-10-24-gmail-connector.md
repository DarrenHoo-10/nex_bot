# Gmail connector

Worktree: `codex/gmail-connector`, based on main `62642521`.

The connector settings screen offers Gmail alongside existing custom MCP
connections. Gmail v1 supports live email search, message reading and thread
reading, using only `gmail.readonly`. Sending, drafts, mailbox changes, background
sync and attachment downloads are outside this first delivery.

Reuse the Core connector registry, encrypted vault, per-Agent grants, broker,
cancellation and version checks. A provider adapter owns Google's endpoints and
tool schemas; a shared OAuth coordinator owns account linking and credentials.
Existing MCP records migrate additively with provider `mcp`.

Google's web application OAuth client is configured by the Core operator, using
environment variables. End users select Connect, consent in their browser and
return to settings. Never put client secrets, authorization codes or tokens into
UI state, logs, plans or source control. The UI shows only availability, account,
connection status, tools and grants. Unconfigured installations show an honest
unavailable state.

Authorization uses short-lived, single-use random state and PKCE, bound to the
initiating authenticated session and workspace. Callback routing resolves the
owning workspace by the pending state rather than cookies. Recheck the initiating
session before and after external requests. Denial, cancellation, logout,
configuration changes and shutdown invalidate pending work. Reconnecting must
match the existing email account. Different mailboxes receive separate records
and grants. Refresh requests are serialized per connection. Disconnect removes
local credentials and grants immediately and attempts provider revocation.

Verification uses disposable Core databases and a loopback fake Google provider:
OAuth callback/replay/expiry/denial, account isolation, encrypted persistence,
refresh/revocation, granted worker calls, stale versions, cancellation, malformed
responses and error redaction. Inspect the real renderer at desktop and mobile
widths, including blocked-popup recovery. No live account mutations, production
deployment or installer publication are part of this worktree.

Hindsight tools were not exposed in this session; discovery returned no matching
tools. The current architecture was checked against source and the existing
Personal workspace verification recipe.

References: [Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[message search](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[message reading](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

The follow-up visual references change the settings presentation to a compact
service catalog and a full-width detail view with account, tool, application and
information sections. Mailboxes remain separate records grouped under Gmail;
each retains independent assistant grants. The reference's draft/manage wording
and tool count do not expand the implemented read-only scope. Current design
screenshots and acceptance results are linked from the Gmail verification recipe.

The compatibility follow-up extends Gmail to both native Apple clients through
NexClientKit and a shared SwiftUI catalog/detail page. Windows keeps its existing
system-browser IPC; Android keeps its authenticated native HTTP bridge and opens
consent outside its WebView. Returning to the foreground refreshes authorization
status; Back unwinds the connector page and cancels abandoned consent. All clients
share the same account records, independent assistant grants and read-only tools.
This work does not publish clients or connect a personal mailbox.
