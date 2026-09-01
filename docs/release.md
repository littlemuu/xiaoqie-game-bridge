# Reproducible RC release process

## Scope and version source

`package.json` is the single release-version source. `package-lock.json`, the
release CLI result, bundle name, SBOM component and release manifest must match
it exactly; the build fails when they disagree. The RC remains `private: true`
and is never published to npm.

The artifact schema is version 1. Every manifest records the fixed Issue #17
baseline commit, actual build commit, repository/ref, exact Node/npm versions,
platform and architecture. Timestamps, random IDs, absolute paths, runner names
and usernames are deliberately absent from normalized assets.

## Canonical builder

Use exact Node 22.23.1 from `.nvmrc` in a clean checkout:

```text
npm ci
npm run check
npm test
npm run demo
npm run build
npm audit
npm run release:workflow-policy
npm run release:reproducible
npm run release:build
npm run release:verify
git diff --check
```

The reproducibility command refuses a dirty source tree, creates two precisely
owned temporary local clones, checks out the same commit in each, performs
`npm ci --offline` from the already populated cache, builds twice and compares
the canonical bundle bytes/digest. It deletes only those two temporary clones.
The script contains no network client and does not access a game, account,
launcher, save, desktop, host MCP configuration or user-selected file.

## Bundle allowlist and normalization

The gzip-compressed USTAR bundle has one versioned root and contains only:

- normalized built JavaScript below `dist/src`;
- TypeScript runtime source below `src`;
- the fixed Windows helper source and fixed build script;
- release tooling source, package/lock/config metadata and `.nvmrc`;
- README, changelog and repository release/security/architecture documents.

All entries are regular files, sorted by archive path, mode `0644`, owner/group
zero and timestamp zero. Text line endings are normalized to LF; gzip time and
OS metadata are fixed. `.git`, `node_modules`, coverage, caches, temporary data,
audit ledgers, runtime descriptors, logs, environment files, EXE/DLL files and
credential/host-identity-shaped content are rejected. Native executables are
built from the included reviewed C++ source after extraction; none is shipped
or downloaded at runtime.

## Evidence binding

The outer release allowlist has exactly five files:

1. the canonical `tar.gz` bundle;
2. a checksum list for the other four files (never itself);
3. a CycloneDX 1.6 JSON SBOM derived from the production lockfile closure and
   bound to the bundle SHA-256;
4. a versioned release manifest that binds source, bundle, SBOM, provenance,
   build environment and every archive member;
5. an unsigned in-toto/SLSA provenance statement bound to the bundle and source.

The local provenance JSON is build metadata, not a signature or GitHub/SLSA
attestation. Only the protected tag workflow invokes GitHub's official pinned
attestation action. A checksum detects changed bytes but not publisher identity;
an SBOM inventories declared production components but does not prove absence
of vulnerabilities or undeclared behavior; an attestation binds a platform
identity to an artifact digest but does not prove code safety, reproducibility,
complete isolation or real-game safety.

## Windows evidence

Generate a Vitest JSON report in a repository-owned ignored directory, build the
release evidence, then run:

```text
npm run windows:evidence -- --test-results release-input/vitest.json --release-dir release-out
```

The report records only closed-world counts, skip categories, exact tool/OS
versions, elevation/host-Job state, trusted containment policy decisions,
cleanup results, source state and bundle digest. It never copies raw test
failure text. No path, PID, SID, username, token handle, command line, stack or
secret is serialized. It requests no elevation and changes no registry, ACL,
firewall, system policy or global environment.

An elevated runner can only report `elevated-fail-closed-only`. Failed or
unknown assertions remain unverified; skipped assertions are counted by safe
category and prevent an unqualified `allRegisteredTestsPassed` claim. Real
non-elevated evidence requires an actual non-elevated Windows session.

## Tag, publish and rollback

Draft PRs never create or move tags, Releases, deployments or npm publications.
After maintainer review and merge, the maintainer may create the annotated,
protected `v0.1.0-rc.1` tag at the exact merge commit. The tag-only workflow
checks protection, annotated tag type and target commit before receiving its
minimal `contents`, `id-token` and `attestations` write permissions. It performs
a clean rebuild, validation and GitHub attestation, creates a draft prerelease,
uploads only the five files, downloads them again, verifies digests and the
attestation subject, and only then publishes the prerelease. Missing evidence,
unsupported attestation, upload failure or digest mismatch leaves the job
failed and never records a successful publication.

If a prerelease is defective, mark it withdrawn or delete the current public
listing only according to maintainer policy while retaining the tag, workflow
logs and downloaded evidence. Never move/reuse the tag or overwrite historical
assets. Fixes use a new prerelease version and a new annotated tag.
