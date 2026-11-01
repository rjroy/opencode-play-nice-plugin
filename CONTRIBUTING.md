# Contributing

This is a private OpenCode 2.2.2 V2 plugin. Use the pinned Bun version and lockfile
from `package.json` and `bun.lock`. Install dependencies from a trusted checkout:

```sh
bun --no-env-file install --frozen-lockfile
```

Run these checks from the repository root when relevant to a change:

```sh
bun --no-env-file run test
bun --no-env-file run typecheck
bun --no-env-file run test:native:guards
bun --no-env-file run build
bun --no-env-file run test:package
```

`test:package` needs a successful build first. It checks source package
contracts and resolves and loads the compiled exports. It does not prove native
execution of `dist`. The ordinary unit and reconnect tests use controlled
dependencies and do not require a live Decision service or chat provider.

The [native test guide](tests/native/README.md) describes the separate opt-in
OpenCode process, its trusted-binary prerequisites, isolation, and evidence
limits. Do not change host configuration to make a native preflight pass.

The build replaces `dist/`. The checkout root exports TypeScript source for
development, while `dist/` has its own generated compiled manifest. See
[Packaging](README.md#packaging) before configuring either package.
