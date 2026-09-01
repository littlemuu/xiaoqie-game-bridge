export interface VitestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  unknown: number;
  allRegisteredTestsPassed: boolean;
  inventory: any;
  skippedCategories: Array<{ category: string; count: number }>;
}
export const TEST_INVENTORY_SCHEMA: string;
export const FULL_SUITE_FILES: readonly string[];
export function summarizeVitest(value: unknown, suiteKind?: "full" | "elevated-gate"): VitestSummary;
export function evidenceStatusFor(options: { platform: string; elevated: boolean | null; clean: boolean; vitest: VitestSummary; containmentVerified: boolean }): string;
export function generateWindowsEvidence(options: { testResults: string; releaseDirectory: string; suiteKind: "full" | "elevated-gate" }): {
  evidence: any;
  serialized: string;
};
