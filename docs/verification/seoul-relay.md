# Seoul HTTPS relay verification — 2026-10-17

The public NexBot hostname now resolves directly to the Seoul reverse proxy.
Tokyo continues to run Core 0.8.1 with its existing accounts and data. This
deployment changes the network entry point, not the application build.

## Transport and maintenance

- Seoul serves a Let's Encrypt certificate for the existing hostname, valid
  until 2027-01-15. Certbot's renewal timer is active and a staging renewal
  succeeded. Existing deploy hooks reload Nginx after renewal.
- Seoul forwards to Tokyo over TLS with hostname and certificate validation
  enabled. Tokyo's previous certificate did not contain the NexBot hostname;
  a dedicated origin certificate and private CA replace it for this virtual
  host only. Only the public CA certificate was copied to Seoul. Private keys
  remain on their respective servers.
- The origin certificate is checked daily and renewed when fewer than 30 days
  remain. Its renewal service completed successfully without rotating a
  certificate that was not due. The private CA expires in 2036 and requires
  a planned trust-bundle rotation before then.
- Both proxies support WebSocket upgrades and unbuffered SSE. The Seoul proxy
  overwrites forwarded client-address headers; Tokyo trusts that address only
  from explicitly configured proxy IPs. API responses are not cached and
  failed requests are not retried automatically by the relay.
- Backups of both Nginx configurations are retained on the servers. The
  example configuration is [nginx-relay.conf.example](../../deploy/core/nginx-relay.conf.example).
- The existing memory-service DNS record was corrected to Tokyo's current
  public address after the instance restart, retaining its original Cloudflare
  proxy mode. The unauthenticated public entry redirected to login, and the
  local Hindsight health endpoint returned 200; no real memories were queried.

## Isolated message loading measurement

The exact deployed Core and UI ran in a separate temporary Tokyo directory,
with a loopback synthetic identity provider, new vault key, two synthetic
agents and 60 seeded messages per agent. Production account databases were
never opened by the fixture. A temporary random-header route selected that
fixture; the test checked its Core ID before operating the UI or pairing a
device. Hidden Electron renderers used fresh, independent profiles and valid
HTTPS certificates. No certificate validation was disabled.

Both measurements used the same hostname and data. The Cloudflare comparison
was taken **after** the domain's origin had been changed to Seoul, so its path
was client → Cloudflare → Seoul → Tokyo; it is not a historical measurement of
the former client → Cloudflare → Tokyo deployment. The direct comparison used
client → Seoul → Tokyo. Host resolution was fixed per test process to avoid
the local recursive DNS cache, without changing system DNS or hosts entries.

| Measurement | Via Cloudflare | Direct to Seoul |
| --- | ---: | ---: |
| Initial UI navigation through first history display, one run | 5,023 ms | 817 ms |
| Contact switch through history render, median of eight | 835 ms | 102 ms |
| Contact switch range | 684–1,589 ms | 95–122 ms |
| History API, median of six | 604 ms | 63 ms |
| History API range | 601–954 ms | 62–64 ms |
| New SSE connection through first change event | 523 ms | 62 ms |

An additional synthetic device paired through the production relay's WSS
path, completed its authenticated hello in 187 ms and was revoked afterwards.
The temporary route was removed, its exact pre-test configuration restored,
and the fixture service stopped. The production health response remained 200.

Evidence is stored in the ignored `release/deployment-seoul-relay/` directory:
`cloudflare.json`, `seoul.json`, `websocket.json`, renderer screenshots and DNS
screenshots. These are small-sample observations from this computer, not a
guaranteed latency or a measurement of model generation time.

## DNS cache limitation

The authoritative nameserver and public resolver returned the Seoul address
after cutover. The local router resolver continued to return the old
Cloudflare addresses with a 600-second TTL at verification time. A Windows
DNS cache flush did not clear that upstream cache. Existing clients can keep
using the old path until their resolver cache and connections refresh; no
global DNS settings or persistent hosts overrides were installed.

## Rollback

To reintroduce Cloudflare while retaining the relay, enable proxying for the
same Seoul A record; the public certificate is valid for strict TLS. To return
to a direct Tokyo origin, first restore the prior Tokyo virtual-host TLS
configuration and validate the original Cloudflare TLS mode, then update the
DNS record to Tokyo's **current** public address. Never reuse the pre-restart
address without confirming it still belongs to the instance.
