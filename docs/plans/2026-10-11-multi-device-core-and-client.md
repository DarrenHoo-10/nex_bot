# Primary Core, thin clients and synchronized personal Agents

Status: implemented and qualified in release 0.5.0. The packaged Core/Node
workflow suite passes 61 tests; two additional transport tests pass. The real
client portable EXE passes dual-client message/routine/approval/privacy checks.
The packaged Core passes the normal desktop and native Hindsight memory smokes.

## Deployment and identity

One primary device runs the modular Core, Pi workers, scheduler, SQLite and
Hindsight/PostgreSQL. Other devices run NexBot Client and optionally Device Node;
they do not create Agents or memory banks locally. Two independent Cores are
separate personal workspaces and are not automatically merged.

Client Identity v1 exposes identity discovery, one-time-code login, session
exchange and logout. Current authentication adapter is local-owner mode. A Core
owner creates a 192-bit code, valid ten minutes and usable once. Login creates
an independently revocable thirty-day user session. Persist only token hashes
in Core and Windows-encrypted credentials on clients. Native Identity API/OIDC
remain future adapters to the same user/session/domain contract.

Client credentials and DCP device credentials are separate. Logging in permits
the owner's control UI; a Device Node still requires an independently paired
device token, native directory selection and explicit local terminal consent.
Each dangerous execution then requires approval in its executing Agent's feed.
A2A and creating routine plans are automatic under the Agent's tool policy.

## Message and task consistency

Agent feed sequence is assigned by Core in the transaction that commits a
message. A submitted client message has a UUID idempotency key; retries with
that key cannot create duplicate inputs. One unfinished Task per Agent remains
the serialization boundary; concurrent messages are steering under the existing
input rules. Routine occurrences wait behind active work.

SQLite triggers append body-free durable change markers. SSE includes cursor,
Core identity, process generation and privacy epoch. A stale/invalid event
cursor demands a snapshot. Messages have ascending `after` pages of 200 and
history `before` pages of 100. Clients drain missing pages, never assuming that
the newest hundred cover a reconnect gap. Read position is owner-wide.

Approvals use the committed call hash and policy versions; only the first valid
decision succeeds, and the actual deciding user session is recorded. Connection
loss clears displayed cached private content until Core authenticates and
resynchronizes it. A revoked session loses API/SSE access.

## Memory and privacy

Memory lives only on Core: one private bank per abstract Agent and the workspace
shared bank. Queries search those two scopes. Peer identity/capability directory
is public to the owner's Agents; private peer facts require A2A and a relevant
reply. No Agent name determines routing or access.

Content redaction, withdrawal and deletion increment the durable privacy epoch.
Clients discard old history, streaming text and memory views on epoch changes.
Responses from different generations are not merged. Full forgetting retains
the existing source/copy/Task/Pi/native-bank fences and tombstones. Offline
clients are not independent writable memory replicas.

## Chat scheduling

Generic Broker actions: `routine.list`, `routine.save`, `routine.toggle`,
`routine.run`. All operations are scoped to the executing Agent. Relative
delays are calculated on Core; daily plans have explicit IANA time zones.
Occurrence identity and per-tool-call receipts prevent duplicate schedules or
manual runs after lost acknowledgements/restart. The current Core clock and
actual capabilities are supplied at every model request.

The migration upgrades former standard tool policies. The earliest seven-action
default is recognized only at policy version 1 (never edited). Custom restricted
policies retain their grants and can enable routine tools in the permissions UI.
Scheduling a dangerous action does not authorize that future action.

## Qualification boundaries

Use disposable Core and two disposable client profiles, synthetic models and
authorized fixture directories. Verify packaged bytes, reconnect gaps larger
than 100 messages, session revocation/restart, two-terminal privacy clearing,
generic scheduling and exactly-once receipts. Never exercise tests on the
owner's live workspace. No credentials or user history belong in release files.
