export interface VitestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  unknown: number;
  allRegisteredTestsPassed: boolean;
  skippedCategories: Array<{ category: string; count: number }>;
}
export function summarizeVitest(value: unknown): VitestSummary;
export function generateWindowsEvidence(options: { testResults: string; releaseDirectory: string }): {
  evidence: any;
  serialized: string;
};
