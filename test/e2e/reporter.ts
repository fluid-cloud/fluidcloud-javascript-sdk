import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One recorded live call, mirroring the Go SDK e2e report rows. */
export interface E2EResult {
  category: string;
  fn: string;
  provider: string;
  status: 'pass' | 'fail' | 'skip';
  error?: string;
  durationMs: number;
}

const RESULTS_PATH = 'test_results.json';
const REPORT_PATH = 'TEST_RESULTS.md';

/** Appends one result. Suites run in separate workers, so this goes through disk. */
export function record(result: E2EResult): void {
  const all = readResults();
  all.push(result);
  mkdirSync(dirname(RESULTS_PATH) === '.' ? '.' : dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(all, null, 2));
}

/**
 * Runs one live call, records the outcome, and never fails the surrounding test —
 * the report is the artifact, exactly as the Go harness behaves.
 */
export async function runFn(category: string, fn: string, provider: string, body: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await body();
    record({ category, fn, provider, status: 'pass', durationMs: Date.now() - started });
  } catch (err) {
    record({
      category,
      fn,
      provider,
      status: 'fail',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    });
  }
}

/** Records a skipped call with the reason. */
export function recordSkip(category: string, fn: string, provider: string, reason: string): void {
  record({ category, fn, provider, status: 'skip', error: reason, durationMs: 0 });
}

function readResults(): E2EResult[] {
  try {
    return JSON.parse(readFileSync(RESULTS_PATH, 'utf8')) as E2EResult[];
  } catch {
    return [];
  }
}

export async function setup(): Promise<void> {
  rmSync(RESULTS_PATH, { force: true });
  rmSync(REPORT_PATH, { force: true });
}

export async function teardown(): Promise<void> {
  const results = readResults();
  if (results.length === 0) return;

  const providers = [...new Set(results.map((r) => r.provider))].sort();
  const categories = [...new Set(results.map((r) => r.category))];
  const counts = {
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length,
  };

  const lines: string[] = [
    '# FluidCloud JS SDK - E2E Test Report',
    '',
    '| | |',
    '|---|---|',
    `| **Run at** | ${new Date().toISOString()} |`,
    `| **Providers** | ${providers.join(', ')} |`,
    `| **Passed** | ${counts.pass} |`,
    `| **Failed** | ${counts.fail} |`,
    `| **Skipped** | ${counts.skip} |`,
    `| **Total** | ${results.length} |`,
    '',
  ];

  for (const category of categories) {
    const rows = results.filter((r) => r.category === category);
    const fns = [...new Set(rows.map((r) => r.fn))];

    lines.push(`## ${category}`, '');
    lines.push(`| # | Function | ${providers.map((p) => p.toUpperCase()).join(' | ')} |`);
    lines.push(`| :---: | :--- | ${providers.map(() => ':---:').join(' | ')} |`);

    fns.forEach((fn, i) => {
      const cells = providers.map((provider) => {
        const row = rows.find((r) => r.fn === fn && r.provider === provider);
        if (!row) return '-';
        if (row.status === 'pass') return 'PASS';
        if (row.status === 'skip') return `SKIP (${row.error ?? ''})`;
        return `FAIL (${(row.error ?? '').slice(0, 80)})`;
      });
      lines.push(`| ${i + 1} | \`${fn}\` | ${cells.join(' | ')} |`);
    });
    lines.push('');
  }

  writeFileSync(REPORT_PATH, lines.join('\n'));
  process.stdout.write(
    `\nE2E report written to ${REPORT_PATH} — ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped\n`,
  );
}
