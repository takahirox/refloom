# Website capture foundation

This foundation is internal infrastructure only. It is not connected to the UI,
HTTP API, MCP surface, or domain persistence.

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

## Limits

This is defense in depth, not perfect browser or operating-system sandboxing.
It does not defend against a compromised Chrome binary, kernel, local user, or
unknown browser vulnerability. The proxy cannot make hostile content safe to
render elsewhere. Public destinations can themselves proxy traffic or return
sensitive content available to the operator. IP classification and known Chrome
paths require maintenance as platforms evolve.

Video, animation recording, scripted interaction, and assisted-motion capture
are deliberately deferred. Any future public integration needs separate review
of authorization, persistence, provenance, retention, and user-visible limits.
