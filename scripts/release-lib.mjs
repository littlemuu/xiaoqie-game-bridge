import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "https://github.com/littlemuu/xiaoqie-game-bridge";
export const BASE_COMMIT = "ce604a17508affd9619efbbe925d46ac1bc1839c";
export const ARTIFACT_SCHEMA_VERSION = "1";
export const RELEASE_MANIFEST_SCHEMA = "xiaoqie.release/v1";
export const WINDOWS_EVIDENCE_SCHEMA = "xiaoqie.windows-evidence/v1";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXTENSIONS = new Set([
  "", ".cjs", ".cpp", ".json", ".js", ".md", ".mjs", ".nvmrc", ".ts", ".yml", ".yaml",
]);
const STATIC_FILES = [
  ".nvmrc",
  "CHANGELOG.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  "native/windows-worker-launcher.cpp",
];
const TREE_RULES = [
  ["dist/src", new Set([".js"])],
  ["src", new Set([".ts"])],
  ["scripts", new Set([".mjs"])],
  ["docs", new Set([".md", ".json"])],
];
const FORBIDDEN_PATH = /(^|\/)(?:\.git|node_modules|coverage|release-out|\.cache|tmp|temp)(?:\/|$)|(?:\.exe|\.dll|\.log)$|(^|\/)\.env(?:\.|$)/iu;
const CREDENTIAL_VALUE = /(?:Bearer\s+[A-Za-z0-9._~+/=-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;
const ABSOLUTE_IDENTITY = /(?:[A-Za-z]:\\(?:Users|windows\\temp)\\|\/(?:home\/runner|Users|tmp)\/)/iu;

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function extension(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function normalizeText(path, data) {
  if (!TEXT_EXTENSIONS.has(extension(path))) return data;
  const text = data.toString("utf8");
  if (text.includes("\u0000")) throw new Error(`Text allowlist entry contains NUL: ${path}`);
  return Buffer.from(text.replace(/\r\n?/gu, "\n"), "utf8");
}

function walkFiles(root, directory, allowedExtensions) {
  const absolute = join(root, directory);
  const output = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = `${directory}/${entry.name}`.replaceAll("\\", "/");
    const childAbsolute = join(root, ...childRelative.split("/"));
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are forbidden in the release allowlist: ${childRelative}`);
    if (entry.isDirectory()) output.push(...walkFiles(root, childRelative, allowedExtensions));
    else if (entry.isFile() && allowedExtensions.has(extension(childRelative))) output.push(childRelative);
  }
  return output;
}

export function collectBundleFiles(root) {
  const paths = [...STATIC_FILES];
  for (const [directory, extensions] of TREE_RULES) paths.push(...walkFiles(root, directory, extensions));
  const unique = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  return unique.map((path) => {
    const safePath = path.replaceAll("\\", "/");
    if (FORBIDDEN_PATH.test(safePath) || safePath.startsWith("/") || safePath.includes("../")) {
      throw new Error(`Forbidden release path: ${safePath}`);
    }
    const absolute = join(root, ...safePath.split("/"));
    const stat = lstatSync(absolute);
    if (!stat.isFile()) throw new Error(`Release allowlist entry is not a regular file: ${safePath}`);
    const data = normalizeText(safePath, readFileSync(absolute));
    if (CREDENTIAL_VALUE.test(data.toString("utf8")) || ABSOLUTE_IDENTITY.test(data.toString("utf8"))) {
      throw new Error(`Release allowlist entry contains credential-shaped or host-identity content: ${safePath}`);
    }
    return { path: safePath, data };
  });
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error("Tar numeric field overflow.");
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Tar path is too long: ${path}`);
}

function tarHeader(path, size) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(path);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function createCanonicalTarGzip(prefix, files) {
  const chunks = [];
  for (const file of files) {
    const archivePath = `${prefix}/${file.path}`;
    chunks.push(tarHeader(archivePath, file.data.byteLength), file.data);
    const padding = (512 - (file.data.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  archive[9] = 0xff;
  return archive;
}

export function readCanonicalTarGzip(archive) {
  const tar = gunzipSync(archive);
  const files = [];
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid tar size.");
    const expectedChecksum = Number.parseInt(header.subarray(148, 154).toString("ascii").trim(), 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (expectedChecksum !== actualChecksum || header[156] !== "0".charCodeAt(0)) {
      throw new Error("Invalid canonical tar header.");
    }
    offset += 512;
    if (offset + size > tar.byteLength) throw new Error("Truncated tar entry.");
    files.push({ path, data: Buffer.from(tar.subarray(offset, offset + size)) });
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

function run(root, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.inherit ? "inherit" : "pipe",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = options.inherit ? "" : String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail === "" ? "." : `: ${detail}`}`);
  }
  return options.inherit ? "" : String(result.stdout).trim();
}

function runNpm(root, args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (typeof npmCli === "string" && npmCli !== "") return run(root, process.execPath, [npmCli, ...args], options);
  if (process.platform === "win32") throw new Error("Windows release commands must be invoked through npm so npm_execpath is fixed.");
  return run(root, "npm", args, options);
}

function git(root, args) {
  return run(root, "git", args);
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function packageComponents(lock) {
  const packages = lock.packages;
  if (typeof packages !== "object" || packages === null) throw new Error("Unsupported package-lock packages map.");
  const root = packages[""];
  const queue = Object.keys(root.dependencies ?? {}).sort();
  const seen = new Set();
  const components = [];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    let key = `node_modules/${name}`;
    const entry = packages[key];
    if (typeof entry !== "object" || entry === null || typeof entry.version !== "string") {
      throw new Error(`Production dependency is missing from package-lock: ${name}`);
    }
    const component = {
      type: "library",
      name,
      version: entry.version,
      purl: `pkg:npm/${encodeURIComponent(name).replace("%40", "@")}@${entry.version}`,
    };
    if (typeof entry.integrity === "string" && entry.integrity.startsWith("sha512-")) {
      component.hashes = [{ alg: "SHA-512", content: Buffer.from(entry.integrity.slice(7), "base64").toString("hex") }];
    }
    components.push(component);
    for (const dependency of Object.keys(entry.dependencies ?? {}).sort()) {
      if (!seen.has(dependency)) queue.push(dependency);
    }
  }
  return components.sort((a, b) => a.purl.localeCompare(b.purl));
}

function sourceIdentity(root, options) {
  const commit = options.commit ?? process.env.GITHUB_SHA ?? git(root, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("Build commit must be a full lowercase Git SHA.");
  const ref = options.ref ?? process.env.GITHUB_REF ?? (() => {
    try { return git(root, ["symbolic-ref", "-q", "HEAD"]); } catch { return `detached/${commit}`; }
  })();
  if (!/^(?:refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+|refs\/pull\/[1-9][0-9]*\/merge|detached\/[0-9a-f]{40})$/u.test(ref)) {
    throw new Error("Build ref is outside the closed release source format.");
  }
  return { repository: REPOSITORY, ref, commit, baseCommit: BASE_COMMIT };
}

function assertClean(root) {
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new Error("Canonical release build requires a clean source tree.");
}

function exactKeys(value, keys, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unknown or missing fields.`);
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be SHA-256.`);
}

export function buildRelease(options = {}) {
  const root = resolve(options.root ?? scriptRoot);
  const outputDirectory = resolve(options.outputDirectory ?? join(root, "release-out"));
  if (!options.allowDirty) assertClean(root);
  const packageJson = json(join(root, "package.json"));
  const lock = json(join(root, "package-lock.json"));
  if (packageJson.private !== true) throw new Error("package.json must remain private.");
  if (packageJson.version !== lock.version || packageJson.version !== lock.packages?.[""]?.version) {
    throw new Error("Package and lockfile versions disagree.");
  }
  if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+-rc\.\d+$/u.test(packageJson.version)) throw new Error("Release version must be an RC semantic version.");
  if (!options.skipCompile) runNpm(root, ["run", "build"], { inherit: true });
  const source = sourceIdentity(root, options);
  const npmVersion = runNpm(root, ["--version"]);
  const files = collectBundleFiles(root);
  const prefix = `${packageJson.name}-${packageJson.version}`;
  const bundleName = `${prefix}.tar.gz`;
  const bundle = createCanonicalTarGzip(prefix, files);
  const bundleDigest = sha256(bundle);
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, bundleName), bundle, { mode: 0o644 });

  const sbomName = `${prefix}.sbom.cdx.json`;
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: packageJson.name,
        version: packageJson.version,
        purl: `pkg:npm/${packageJson.name}@${packageJson.version}`,
        hashes: [{ alg: "SHA-256", content: bundleDigest }],
      },
    },
    components: packageComponents(lock),
  };
  const sbomBytes = Buffer.from(stableJson(sbom));
  writeFileSync(join(outputDirectory, sbomName), sbomBytes, { mode: 0o644 });

  const provenanceName = `${prefix}.provenance.json`;
  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: bundleName, digest: { sha256: bundleDigest } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: `${REPOSITORY}/blob/${source.commit}/docs/release.md#canonical-builder`,
        externalParameters: {
          repository: source.repository,
          ref: source.ref,
          commit: source.commit,
          version: packageJson.version,
        },
        internalParameters: { artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION },
        resolvedDependencies: [{ uri: `git+${source.repository}@${source.ref}`, digest: { gitCommit: source.commit } }],
      },
      runDetails: { builder: { id: "urn:xiaoqie-game-bridge:canonical-node22-builder:v1" } },
    },
  };
  const provenanceBytes = Buffer.from(stableJson(provenance));
  writeFileSync(join(outputDirectory, provenanceName), provenanceBytes, { mode: 0o644 });

  const manifestName = `${prefix}.release-manifest.json`;
  const manifest = {
    schema: RELEASE_MANIFEST_SCHEMA,
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    version: packageJson.version,
    source,
    buildEnvironment: {
      node: process.version,
      npm: npmVersion,
      platform: process.platform,
      architecture: process.arch,
    },
    bundle: { name: bundleName, sha256: bundleDigest, bytes: bundle.byteLength },
    sbom: { name: sbomName, sha256: sha256(sbomBytes), format: "CycloneDX-1.6-json" },
    provenance: {
      name: provenanceName,
      sha256: sha256(provenanceBytes),
      format: "in-toto-statement-slsa-provenance-v1",
      signedAttestation: false,
    },
    files: files.map((file) => ({ path: file.path, sha256: sha256(file.data), bytes: file.data.byteLength })),
    support: {
      linuxCanonicalBundle: "verified-by-reproducibility-job",
      githubHostedWindows: "elevated-fail-closed-only",
      nonElevatedWindows: "requires-separate-real-host-evidence",
      realGame: "unsupported",
    },
  };
  const manifestBytes = Buffer.from(stableJson(manifest));
  writeFileSync(join(outputDirectory, manifestName), manifestBytes, { mode: 0o644 });

  const checksumName = `${prefix}.sha256`;
  const checksums = [
    [bundleDigest, bundleName],
    [sha256(manifestBytes), manifestName],
    [sha256(provenanceBytes), provenanceName],
    [sha256(sbomBytes), sbomName],
  ].sort((a, b) => a[1].localeCompare(b[1]));
  writeFileSync(join(outputDirectory, checksumName), `${checksums.map(([digest, name]) => `${digest}  ${name}`).join("\n")}\n`, { mode: 0o644 });
  for (const name of [bundleName, sbomName, provenanceName, manifestName, checksumName]) chmodSync(join(outputDirectory, name), 0o644);
  return { outputDirectory, manifest, checksumName };
}

function parseChecksums(text) {
  const entries = new Map();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
    if (!match || entries.has(match[2])) throw new Error("Checksum manifest is malformed or duplicated.");
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function verifyRelease(options = {}) {
  const root = resolve(options.root ?? scriptRoot);
  const outputDirectory = resolve(options.outputDirectory ?? join(root, "release-out"));
  const packageJson = json(join(root, "package.json"));
  const prefix = `${packageJson.name}-${packageJson.version}`;
  const names = {
    bundle: `${prefix}.tar.gz`,
    manifest: `${prefix}.release-manifest.json`,
    provenance: `${prefix}.provenance.json`,
    sbom: `${prefix}.sbom.cdx.json`,
    checksum: `${prefix}.sha256`,
  };
  const actualOutput = readdirSync(outputDirectory).sort();
  const expectedOutput = Object.values(names).sort();
  if (JSON.stringify(actualOutput) !== JSON.stringify(expectedOutput)) throw new Error("Release output does not match the exact artifact allowlist.");
  const manifest = json(join(outputDirectory, names.manifest));
  exactKeys(manifest, ["schema", "artifactSchemaVersion", "version", "source", "buildEnvironment", "bundle", "sbom", "provenance", "files", "support"], "release manifest");
  if (manifest.schema !== RELEASE_MANIFEST_SCHEMA || manifest.artifactSchemaVersion !== ARTIFACT_SCHEMA_VERSION || manifest.version !== packageJson.version) {
    throw new Error("Release manifest schema or version mismatch.");
  }
  exactKeys(manifest.source, ["repository", "ref", "commit", "baseCommit"], "release source");
  if (manifest.source.repository !== REPOSITORY || manifest.source.baseCommit !== BASE_COMMIT) throw new Error("Release source repository or baseline mismatch.");
  if (options.expectedCommit !== undefined && manifest.source.commit !== options.expectedCommit) throw new Error("Release commit does not match the expected commit.");
  if (options.expectedRef !== undefined && manifest.source.ref !== options.expectedRef) throw new Error("Release ref does not match the expected ref.");
  assertDigest(manifest.bundle.sha256, "bundle digest");
  assertDigest(manifest.sbom.sha256, "SBOM digest");
  assertDigest(manifest.provenance.sha256, "provenance digest");

  const checksums = parseChecksums(readFileSync(join(outputDirectory, names.checksum), "utf8"));
  if (checksums.has(names.checksum) || checksums.size !== 4) throw new Error("Checksum manifest must bind four artifacts and exclude itself.");
  for (const name of [names.bundle, names.manifest, names.provenance, names.sbom]) {
    const digest = sha256(readFileSync(join(outputDirectory, name)));
    if (checksums.get(name) !== digest) throw new Error(`Checksum mismatch: ${name}`);
  }
  if (checksums.get(names.bundle) !== manifest.bundle.sha256 || checksums.get(names.sbom) !== manifest.sbom.sha256 || checksums.get(names.provenance) !== manifest.provenance.sha256) {
    throw new Error("Release manifest digests disagree with checksum manifest.");
  }

  const archiveFiles = readCanonicalTarGzip(readFileSync(join(outputDirectory, names.bundle)));
  const archivePrefix = `${prefix}/`;
  const listed = manifest.files;
  if (!Array.isArray(listed) || listed.length !== archiveFiles.length) throw new Error("Bundle file manifest count mismatch.");
  const expectedPaths = listed.map((file) => file.path);
  const actualPaths = archiveFiles.map((file) => {
    if (!file.path.startsWith(archivePrefix)) throw new Error("Bundle entry prefix mismatch.");
    return file.path.slice(archivePrefix.length);
  });
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error("Bundle archive allowlist mismatch.");
  archiveFiles.forEach((file, index) => {
    const listedFile = listed[index];
    const path = actualPaths[index];
    if (FORBIDDEN_PATH.test(path) || listedFile.bytes !== file.data.byteLength || listedFile.sha256 !== sha256(file.data)) {
      throw new Error(`Bundle file integrity mismatch: ${path}`);
    }
    const text = TEXT_EXTENSIONS.has(extension(path)) ? file.data.toString("utf8") : "";
    if (CREDENTIAL_VALUE.test(text) || ABSOLUTE_IDENTITY.test(text)) throw new Error(`Bundle content policy violation: ${path}`);
  });
  const supportEntry = archiveFiles.find((file) => file.path === `${archivePrefix}docs/support-matrix-v1.json`);
  if (supportEntry === undefined) throw new Error("Versioned support matrix is missing from the bundle.");
  const supportMatrix = JSON.parse(supportEntry.data.toString("utf8"));
  if (supportMatrix.schema !== "xiaoqie.support-matrix/v1" || supportMatrix.release !== packageJson.version || !Array.isArray(supportMatrix.targets) || !Array.isArray(supportMatrix.unsupported)) {
    throw new Error("Versioned support matrix schema or release mismatch.");
  }

  const sbom = json(join(outputDirectory, names.sbom));
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.version !== 1 || !Array.isArray(sbom.components)) throw new Error("SBOM schema mismatch.");
  const sbomComponent = sbom.metadata?.component;
  if (sbomComponent?.name !== packageJson.name || sbomComponent?.version !== packageJson.version || sbomComponent?.hashes?.[0]?.content !== manifest.bundle.sha256) {
    throw new Error("SBOM subject does not bind the release bundle.");
  }
  for (const component of sbom.components) {
    if (component.type !== "library" || typeof component.name !== "string" || typeof component.version !== "string" || typeof component.purl !== "string") {
      throw new Error("SBOM component schema mismatch.");
    }
  }

  const provenance = json(join(outputDirectory, names.provenance));
  if (provenance._type !== "https://in-toto.io/Statement/v1" || provenance.predicateType !== "https://slsa.dev/provenance/v1") throw new Error("Provenance schema mismatch.");
  if (provenance.subject?.length !== 1 || provenance.subject[0]?.name !== names.bundle || provenance.subject[0]?.digest?.sha256 !== manifest.bundle.sha256) {
    throw new Error("Provenance subject does not bind the release bundle.");
  }
  const external = provenance.predicate?.buildDefinition?.externalParameters;
  if (external?.repository !== manifest.source.repository || external?.ref !== manifest.source.ref || external?.commit !== manifest.source.commit || external?.version !== manifest.version) {
    throw new Error("Provenance source identity mismatch.");
  }
  if (manifest.provenance.signedAttestation !== false) throw new Error("Local provenance must not claim a signed platform attestation.");
  return { manifest, names };
}

export function rootDirectory() {
  return scriptRoot;
}

export function safeRelative(root, path) {
  const value = relative(resolve(root), resolve(path));
  if (value === "" || value.startsWith(`..${sep}`) || value === ".." || value.startsWith(sep)) throw new Error("Path must be a child of the selected root.");
  return value;
}
