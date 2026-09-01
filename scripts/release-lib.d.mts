export interface ReleaseOptions {
  root?: string;
  outputDirectory?: string;
  allowDirty?: boolean;
  skipCompile?: boolean;
  expectedCommit?: string;
  expectedRef?: string;
}

export const REPOSITORY: string;
export const BASE_COMMIT: string;
export const ARTIFACT_SCHEMA_VERSION: string;
export const RELEASE_MANIFEST_SCHEMA: string;
export const WINDOWS_EVIDENCE_SCHEMA: string;
export function sha256(data: Buffer | string): string;
export function collectBundleFiles(root: string): Array<{ path: string; data: Buffer }>;
export function createCanonicalTarGzip(prefix: string, files: Array<{ path: string; data: Buffer }>): Buffer;
export function readCanonicalTarGzip(archive: Buffer): Array<{ path: string; data: Buffer }>;
export function buildRelease(options?: ReleaseOptions): { outputDirectory: string; manifest: any; checksumName: string };
export function verifyRelease(options?: ReleaseOptions): { manifest: any; names: Record<string, string> };
export function rootDirectory(): string;
export function safeRelative(root: string, path: string): string;
