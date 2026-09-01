# Website capture

The controlled-browser foundation and progressive persistence service are
implemented. The UI, localhost HTTP API, and MCP tool call that same service.
This is a bounded adapter around the local-first, non-AI core described in
`PRODUCT_SPEC.md`; it does not make autonomous or unrestricted capture a
product principle.

## Runtime packaging and MCP

The Compose app image installs Chromium and sets `REFLOOM_CHROME_PATH` to its
container executable. This lets `docker compose exec -T app node mcp-server.mjs`
use the same private PostgreSQL/S3 network and controlled-browser runtime as the
HTTP application without publishing database or object-store ports.

The app and integration containers run as the image's non-root `node` user with
`no-new-privileges`. `config/chromium-seccomp.json` vendors Docker 29.1.3's
default profile and adds exact-value allowances for only the Chromium sandbox
namespace calls observed in this image: `clone` combinations for user/PID/network
namespaces and `unshare(CLONE_NEWUSER)`. Chromium is not launched with
`--no-sandbox`, and the profile retains Docker's default syscall and capability
restrictions. Re-check the profile when changing the Chromium or Docker base
version. Upstream provenance and the exact added rules are recorded in
`config/README.md`.

`npm run check:browser` launches the configured browser against `about:blank`,
connects to its profile-published loopback CDP endpoint, requests the browser
version, and cleans up the process and temporary profile. It never contacts an
external website. The integration container runs this check before persistence
tests.

If the executable is missing or cannot establish CDP, the MCP tool still returns
the generic `CAPTURE_FAILED` boundary error. A stable `BROWSER_UNAVAILABLE`,
`BROWSER_START_FAILED`, or `CAPTURE_RUNTIME_FAILED` diagnostic is written only
to stderr, without executable/profile paths or captured URLs. Host-process runs
may set `REFLOOM_CHROME_PATH`; MCP callers cannot override it.

## Security invariants

- Only fragment-free `http` URLs on port 80 and `https` URLs on port 443 are
  accepted. Credentials, localhost-style names, single-label names, trailing-dot
  names, and non-public IP space are rejected.
- Literal addresses use `node:net` `isIP`. Hostnames are resolved with
  `dns/promises.lookup({ all: true })`; every returned address must be public.
- Every proxy request and CONNECT tunnel repeats validation. One address from
  that validated answer set is pinned into the outbound connection. The
  application hostname remains the HTTP Host and TLS server name.
- The proxy is loopback-only, is intended solely for its controlled Chrome
  process, strips proxy credentials and hop-by-hop headers, and bounds time,
  bytes, and connection creation. Closing it destroys tracked sockets.
- Chrome uses a new temporary profile, an ephemeral debugging port, the local
  proxy, no inherited session, disabled QUIC/non-proxied UDP, denied downloads,
  disabled cache, and service-worker bypass. Popups are closed.
- Browser, CDP, proxy, sockets, and temporary profile cleanup is attempted on
  success, error, and timeout. Errors crossing the capture boundary are generic
  and do not disclose executable or profile paths.

## Threat model

Captured pages are hostile. They may redirect, create subresources or popups,
return large or slow bodies, change DNS answers, attempt access to local or
reserved services, trigger downloads, or retain state. The proxy is the network
enforcement point: Chrome naturally sends redirect and subresource connections
back through it, where each is resolved and pinned independently.

The deterministic test boundary injects DNS, outbound connectors, proxy, CDP,
process, filesystem, sockets, and clock behavior. Tests require neither an
external site nor an installed browser, and specifically verify that a later DNS
change cannot replace the address selected for an existing outbound connection.

## Capture result and bounds

The driver records the final page URL, title, document and viewport dimensions,
capture time, and representative PNG images. Images include the initial viewport
and a bounded number of evenly spaced deterministic vertical checkpoints after a
bounded settle delay. Navigation readiness, each checkpoint, settling, and the
whole operation have finite deadlines; viewport, page-height metadata, bytes,
and connections are capped.

## Progressive persistence

`captureReference` validates an existing, currently project-owned version-1 URL
Reference before launching the driver. Each completed screenshot is passed
through an awaited callback and
committed immediately as a blob-backed image Asset, an asset Target, and a
Moment. Every record retains original/final URL, title/domain, capture time,
viewport, capture method, strategy, and exact checkpoint position. A later
navigation, renderer, media-limit, or revision failure therefore leaves the
Reference and all previously committed states intact.

Each checkpoint commit reloads authoritative state and retries only bounded
revision races. It never replaces or deletes concurrent UI/MCP work. Concurrent
captures of the same Reference in one process are rejected, while unrelated
References remain independent. Results are explicitly `complete`, `partial`, or
`failed` and expose stable error codes rather than local paths.

## Limits

This is defense in depth, not perfect browser or operating-system sandboxing.
It does not defend against a compromised Chrome binary, kernel, local user, or
unknown browser vulnerability. The proxy cannot make hostile content safe to
render elsewhere. Public destinations can themselves proxy traffic or return
sensitive content available to the operator. IP classification and known Chrome
paths require maintenance as platforms evolve.

The UI never fetches a saved URL unless the user opts in or presses Capture.
The HTTP and MCP surfaces accept only an existing Reference ID and the bounded
viewport/checkpoint/readiness settings; they cannot supply a URL, executable,
proxy, filesystem path, or dependency override. The Reference source URL is
always reloaded as authoritative input.

Video, animation recording, scripted interaction, semantic state detection,
and assisted-motion capture are deliberately deferred.
