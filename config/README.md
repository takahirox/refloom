# Container security profiles

`chromium-seccomp.json` is derived from Moby's Docker 29.1.3 default seccomp
profile at
[`vendor/github.com/moby/profiles/seccomp/default.json`](https://github.com/moby/moby/blob/docker-v29.1.3/vendor/github.com/moby/profiles/seccomp/default.json)
(blob `dafe5cf6a6a3e7f4766037ed0366631b06968160`). Moby is distributed under the
Apache License 2.0.

Refloom adds exact-value rules for the Chromium build in its container image:

- `clone(CLONE_NEWUSER | SIGCHLD)`
- `clone(CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | SIGCHLD)`
- `clone(CLONE_NEWPID | SIGCHLD)`
- `unshare(CLONE_NEWUSER)`

The corresponding s390 argument ordering is included. Keep these rules narrow,
retain `no-new-privileges`, and re-verify them whenever Docker, Alpine, or
Chromium is upgraded.
