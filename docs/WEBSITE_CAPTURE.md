# Website capture

The controlled-browser foundation and progressive persistence service are
implemented. The UI, localhost HTTP API, and MCP tool call that same service.
This is a bounded adapter around the local-first, non-AI core described in
`PRODUCT_SPEC.md`; it does not make autonomous or unrestricted capture a
product principle.

## Runtime packaging and MCP

The Compose app image installs Chromium and Xvfb, sets `REFLOOM_CHROME_PATH` to
the browser executable and `DISPLAY=:99`, and uses a bounded Node entrypoint to
start a fixed `1920x1080x24` display with TCP disabled. The entrypoint waits for
the Unix socket, forwards termination signals to the image command, and cleans
up Xvfb. The app command keeps that container-local X server alive, so HTTP
application and `docker compose exec -T app node mcp-server.mjs` captures share
it; the integration command uses the same runtime. Database, object-store, and
X server ports remain unpublished.

The app and integration containers run as the image's non-root `node` user with
`no-new-privileges`. `config/chromium-seccomp.json` vendors Docker 29.1.3's
default profile and adds exact-value allowances for only the Chromium sandbox
namespace calls observed in this image: `clone` combinations for user/PID/network
namespaces and `unshare(CLONE_NEWUSER)`. Chromium is not launched with
`--no-sandbox`, and the profile retains Docker's default syscall and capability
restrictions. Chromium remains headless, retains its GPU sandbox, and uses
ANGLE with the GL backend and a GPU blocklist override for software WebGL.
Re-check the profile when changing the Chromium or Docker base version.
Upstream provenance and the exact added rules are recorded in `config/README.md`.

`npm run check:browser` launches the configured browser against `about:blank`,
connects to its profile-published loopback CDP endpoint, requests the browser
version, proves that a WebGL or WebGL2 context can be created, and cleans up the
process and temporary profile. It never contacts an external website. The
integration container runs this check before persistence tests.

If the executable is missing or cannot establish CDP, the MCP tool still returns
the generic `CAPTURE_FAILED` boundary error. A stable `BROWSER_UNAVAILABLE`,
`BROWSER_START_FAILED`, `WEBGL_UNAVAILABLE`, or `CAPTURE_RUNTIME_FAILED`
diagnostic is written only to stderr, without executable/profile paths or
captured URLs. A main-document HTTP status of 400 or higher or a failed page
WebGL/WebGL2 context request produces the same public error with the stable
`PAGE_RUNTIME_ERROR` diagnostic before any screenshot is persisted.
Host-process runs may set `REFLOOM_CHROME_PATH`; MCP callers cannot override it.

## Default-on initial capture

Saving a website URL from the UI queues one initial capture by default. The
control is visible before saving and can be unchecked for that Reference. A
shared Workspace preference changes the visible default, while a one-off choice
still wins. Refloom commits the URL Reference before it asks the scheduler to
open the page, so `queued`, `capturing`, `complete`, `partial`, `failed`,
`cancelled`, and explicitly skipped outcomes never roll back the saved URL.
The initial job intentionally stores one desktop viewport. Responsive presets
and richer modes remain an explicit action on the saved Reference, keeping URL
capture immediate and avoiding an unexpected burst of images.

MCP `create_reference` follows the same rule when `sourceUrl` is present. Pass
`capture: false` to opt out, poll `get_capture_status`, and use
`cancel_website_capture` when needed. The creation response separates its
successful `revision`/`entity` from the capture state. Capture failure is not a
failed Reference mutation.

The runtime scheduler starts at most one Chromium capture at a time and accepts
at most eight queued jobs per server/MCP process. Further work returns
`CAPTURE_QUEUE_FULL`; duplicate active work returns `CAPTURE_BUSY`. Cancellation
aborts running browser cleanup and preserves checkpoints already committed.
These limits prevent a burst of UI or agent writes from creating an unbounded
number of browser processes.

Only initial creation is default-on. Editing a URL, recapturing, periodic
monitoring, video, and scripted interaction remain explicit operations.

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
- Chrome stays headless and sandboxed while `--use-gl=angle`, `--use-angle=gl`,
  and `--ignore-gpu-blocklist` make its software WebGL path explicit; neither
  the browser sandbox nor GPU sandbox is disabled. Chrome uses a new temporary
  profile, an ephemeral debugging port, the local
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
capture time, and representative PNG images. Desktop (`1440×900`), tablet
(`1024×768`), and mobile (`390×844`) presets use the same contract in the UI and
MCP. `viewport` stores the initial viewport, `full-page` uses a bounded CDP clip,
and `section` chooses the first useful hero/main/header region and records its
exact coordinates and selector. The legacy custom-width `scroll` mode remains
available for compatibility with existing integrations.

Navigation readiness, settling, the whole operation, screenshot bytes, and
connections have finite limits. A clip above 40 million CSS pixels or an image
above 25 MiB fails with a private `CAPTURE_LIMIT_EXCEEDED` diagnostic; public
HTTP/MCP responses continue to expose only `CAPTURE_FAILED`.

## Progressive persistence

`captureReference` validates an existing, currently project-owned version-1 URL
Reference before launching the driver. Each completed screenshot is passed
through an awaited callback and
committed immediately as a blob-backed image Asset, an asset Target, and a
Moment. Every record retains original/final URL, title/domain, capture time,
viewport, responsive preset, mode, exact captured region, capture method,
strategy, checkpoint position, and screenshot SHA-256. Before adding media, the
service compares that digest with the Reference's existing captured Assets;
identical bytes are reused rather than producing duplicate Assets. A later
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

The UI visibly defaults initial capture on when a website URL is saved; the
user can opt out before saving or disable the shared Workspace default. Later
fetches still require an explicit Capture action. The HTTP and MCP capture
surfaces accept only an existing Reference ID and the bounded
preset/mode/viewport/checkpoint/readiness settings; they cannot supply a URL,
executable, proxy, filesystem path, or dependency override. The Reference source URL is
always reloaded as authoritative input.

Video, animation recording, scripted interaction, semantic state detection,
and assisted-motion capture are deliberately deferred.

## External-agent implementation preview loop

MCP agents can inspect an implementation without adding it to the Reference
library. Call `capture_implementation_preview` with a URL and the same bounded
viewport, responsive preset, and mode settings used by durable capture. Poll
`get_implementation_preview` with the returned opaque capture ID, then read each
returned `refloom://preview/...` resource. Each resource includes its expiry and
the original/final URL, viewport, preset, mode, captured region, checkpoint,
capture time, method, and strategy needed to reproduce the observation.

The intended external loop is:

1. Read Refloom Creative Direction and registered reference media.
2. Change the implementation in the agent's own coding workspace.
3. Start and poll an implementation preview capture.
4. Read the temporary screenshots, evaluate them externally, and repeat.
5. Cancel obsolete work with `cancel_implementation_preview`.

Preview bytes and metadata are process-local memory only. They are never Assets,
References, Targets, Moments, workspace commits, object-store objects, or entries
in durable resource discovery. Completed and failed jobs expire after five
minutes; process shutdown cancels work and releases all bytes. The service also
bounds active and retained jobs, resource count, aggregate bytes, individual PNG
bytes, Chromium runtime, network bytes, connections, checkpoints, and viewports.

Public mode retains the existing public-host and conventional-port policy.
Loopback mode must be selected explicitly and accepts only plain HTTP on an
explicit unprivileged port for exactly `localhost`, `127.0.0.1`, or `::1`.
Every navigation, redirect, subresource, and WebSocket request remains under that
same local-only policy, so loopback preview cannot silently reach public or LAN
destinations. Public failures remain generic and never disclose local paths.
