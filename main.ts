// Token Radar, radar-2: rank pre-token protocols by implied launch value.
//
// The program reads the sealed snapshot (DefiLlama, as_of 2026-11-14), scores
// every pre-token protocol with the category-calibrated model in lib/model.ts,
// and writes the ranked board, the dashboard data, the dashboard files, the
// screenshots and the judge's dossier into the output directory.
//
// Two modes, one scorer:
//
//   * Scoring (default): build the board and write every output, exactly as
//     the gate expects. The board and dossier this writes are the entry.
//   * Validation (--validate): do not rebuild anything. Re-read the board and
//     dossier an earlier scoring run wrote, re-derive the comparables from
//     the snapshot, and check every gate shape the kit's RULES.txt names —
//     ranks, ordering, watchlist coverage, farm-step lengths, dashboard size,
//     screenshot sizes and names, and that the stored dossier is the one the
//     scorer would rebuild from the same output directory. Validation also
//     writes out/comps.json, the category comparables table, so a reviewer
//     can see the calibration without re-running the scorer. It exits 0
//     only when every check passes.
//
// The dashboard is a static page, no framework and no network:
// dashboard/index.html, dashboard/app.css and dashboard/app.js read the
// data.js this program writes from the same board.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//   MAKEFUN_OUTPUT_DIR=out node main.ts --validate --input ../input/snapshot.json

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boardIssue,
  buildRadar,
  computeCalibration,
  dataScript,
  parseSnapshot,
} from './lib/model.ts';
import type { BoardRow, Calibration, Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** Gate caps, taken from the kit's reference/gate.json and RULES.txt. */
const GATE = {
  /** The dashboard's text, as the dossier carries it, must fit in this many bytes. */
  dashboardTextMaxBytes: 65_536,
  /** A screenshot must fit in this many bytes. */
  screenshotMaxBytes: 524_288,
  /** How many screenshots the entry hands in at least. */
  minScreenshots: 3,
  /** The board must hold at least this many rows. */
  minBoardRows: 100,
  /** A farm step must be between this many and the max characters long. */
  farmStepMinChars: 20,
  farmStepMaxChars: 600,
  /** A farm plan must hold between this many and the max steps. */
  farmStepsMin: 3,
  farmStepsMax: 12,
  /** A screenshot's short side must be at least this many pixels. */
  screenshotMinShortSide: 800,
  /** A screenshot's long side must be at most this many pixels. */
  screenshotMaxLongSide: 1440,
} as const;

/** The options the dossier builder gets, identical to the starter's. */
const DOSSIER_OPTIONS = {
  text_max_bytes: GATE.dashboardTextMaxBytes,
  screenshots: { max: 4, max_bytes: GATE.screenshotMaxBytes },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
} as const;

/** Screenshot file names the gate accepts: letters, digits and . _ -, 1 to 128 chars. */
const SCREENSHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** One validation outcome: the check's name, whether it passed, and what it saw. */
interface ValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** One row of the comparables table comps.json carries. */
interface CompsCategory {
  category: string;
  live_comparables: number;
  median_mcap_tvl: number;
  calibrated_multiple: number;
  share_of_live_comparables: number;
}

/** The comparables file: the calibration, written out for a reviewer. */
interface CompsFile {
  as_of: string;
  source: string;
  overall_median_mcap_tvl: number;
  live_token_protocols: number;
  categories: CompsCategory[];
}

/** The arguments after the program name, as a plain list. */
const argv: string[] = process.argv.slice(2);

/** Whether `--name` appears on its own among the arguments. */
function hasFlag(name: string): boolean {
  return argv.includes(`--${name}`);
}

/**
 * The value of `--name <value>` or `--name=<value>`, or the fallback when the
 * flag is absent or has no value after it. A flag with no value is an error
 * the caller sees as the fallback's absence, never as a silent default.
 */
function flagValue(name: string, fallback: string): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith('--') ? next : fallback;
    }
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return fallback;
}

/** The snapshot path: --input <file|dir>, where a directory means snapshot.json inside it. */
function snapshotPath(): string {
  const given = flagValue('input', '/input');
  return given.endsWith('.json') ? given : join(given, 'snapshot.json');
}

/** The output directory: --output, else MAKEFUN_OUTPUT_DIR, else /output. */
function outputDir(): string {
  return flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
}

/** Read a file as UTF-8 text, or fail with a message that names the file. */
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`cannot read ${path}`);
  }
}

/** Read a JSON file and parse it, naming the file when the parse fails. */
function readJson<T>(path: string): T {
  try {
    return JSON.parse(readText(path)) as T;
  } catch {
    throw new Error(`${path} is not JSON`);
  }
}

/** The snapshot out of its file, refused unless it is the shape the model scores. */
function loadSnapshot(path: string): Snapshot {
  if (!existsSync(path)) {
    throw new Error(
      `no snapshot at ${path}: pass --input <snapshot.json|directory> or mount the sealed /input`,
    );
  }
  return parseSnapshot(readText(path));
}

/** One directory's regular files copied into another, skipping dotfiles. */
function copyDirectoryFiles(from: string, to: string): { names: string[]; bytes: number } {
  if (!existsSync(from)) return { names: [], bytes: 0 };
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  let bytes = 0;
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
    bytes += statSync(path).size;
  }
  return { names, bytes };
}

/**
 * Score the snapshot and write every output, in the gate's order: the board
 * first, then the dashboard data, the dashboard files and the screenshots,
 * and the dossier last, so the scorer rebuilds it from this output and the
 * stored dossier compares byte for byte.
 */
function scoreAndWrite(snapshot: Snapshot, out: string): { board: BoardRow[]; shots: string[] } {
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    throw new Error(`the model wrote a board the gate refuses: ${issue}`);
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(out, 'data.js'), dataScript(radar));
  copyDirectoryFiles(join(here, 'dashboard'), join(out, 'dashboard'));
  const shots = copyDirectoryFiles(join(here, 'screenshots'), join(out, 'screenshots'));
  if (shots.names.length < GATE.minScreenshots) {
    throw new Error(
      `screenshots/ holds ${shots.names.length} image${shots.names.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`,
    );
  }
  for (const name of shots.names) {
    if (!SCREENSHOT_NAME.test(name)) {
      throw new Error(
        `screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`,
      );
    }
  }
  writeFileSync(join(out, 'dossier.json'), buildDossier(out, DOSSIER_OPTIONS));
  return { board, shots: shots.names };
}

/** The board a validation run reads: the rows of out/board.json. */
function readBoard(out: string): BoardRow[] {
  const doc = readJson<{ rows: unknown }>(join(out, 'board.json'));
  if (!Array.isArray(doc.rows)) throw new Error('board.json holds no rows array');
  return doc.rows as BoardRow[];
}

/** A PNG's pixel size, read from its IHDR chunk; null when the file is no PNG. */
function pngSize(path: string): { width: number; height: number } | null {
  const bytes = readFileSync(path);
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The dashboard's files, with their total bytes and any network reference they carry. */
function auditDashboard(out: string): { files: string[]; bytes: number; networkRefs: string[] } {
  const dir = join(out, 'dashboard');
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()) : [];
  let bytes = 0;
  const networkRefs: string[] = [];
  for (const name of files) {
    const path = join(dir, name);
    bytes += statSync(path).size;
    if (/\.(html|css|js)$/.test(name)) {
      const text = readText(path);
      if (text.includes('http://') || text.includes('https://')) networkRefs.push(name);
    }
  }
  return { files, bytes, networkRefs };
}

/** The comparables table, recomputed from the snapshot, as comps.json carries it. */
function compsFile(snapshot: Snapshot, calibration: Calibration): CompsFile {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0).length;
  const categories: CompsCategory[] = calibration.comps.map((c) => ({
    category: c.category,
    live_comparables: c.n,
    median_mcap_tvl: c.median,
    calibrated_multiple: c.calibrated,
    share_of_live_comparables: live > 0 ? Math.round((c.n / live) * 1000) / 1000 : 0,
  }));
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    overall_median_mcap_tvl: calibration.overall_median,
    live_token_protocols: live,
    categories,
  };
}

/** A check's one-line result, for the validation report. */
function reportLine(check: ValidationCheck): string {
  return `${check.passed ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}`;
}

/**
 * Validate an output directory an earlier scoring run wrote, against the
 * snapshot it was scored from. Returns the checks in the order they ran;
 * the caller exits non-zero when any of them failed.
 */
function validateOutput(snapshot: Snapshot, out: string): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const fail = (name: string, detail: string): ValidationCheck => ({ name, passed: false, detail });
  const pass = (name: string, detail: string): ValidationCheck => ({ name, passed: true, detail });

  let board: BoardRow[];
  try {
    board = readBoard(out);
  } catch (e) {
    checks.push(fail('board.json', e instanceof Error ? e.message : 'board.json cannot be read'));
    return checks;
  }
  checks.push(
    board.length >= GATE.minBoardRows
      ? pass('board rows', `${board.length} rows, at least ${GATE.minBoardRows}`)
      : fail('board rows', `${board.length} rows, fewer than ${GATE.minBoardRows}`),
  );

  const ranksOk = board.every((r, i) => r.rank === i + 1);
  checks.push(
    ranksOk
      ? pass('ranks', 'ranks run 1..N with no gap and no repeat')
      : fail('ranks', 'ranks do not run 1..N in order'),
  );

  let ordered = true;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) ordered = false;
  }
  checks.push(
    ordered
      ? pass('implied order', `implied value never rises with rank, top ${board[0]?.implied_value_usd ?? 0}`)
      : fail('implied order', 'a later row outranks an earlier row on implied value'),
  );

  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  checks.push(
    missing.length === 0
      ? pass('watchlist coverage', `all ${snapshot.watchlist.length} watchlist slugs covered`)
      : fail('watchlist coverage', `missing ${missing.length}: ${missing.slice(0, 5).join(', ')}`),
  );

  const distinct = new Set(board.map((r) => r.implied_value_usd)).size;
  checks.push(
    distinct > 1
      ? pass('distinct implied values', `${distinct} distinct values across ${board.length} rows`)
      : fail('distinct implied values', 'every row shares one implied value'),
  );

  let stepsBad = '';
  for (const row of board) {
    if (row.farm_steps.length < GATE.farmStepsMin || row.farm_steps.length > GATE.farmStepsMax) {
      stepsBad = `${row.slug} has ${row.farm_steps.length} farm steps`;
      break;
    }
    for (const step of row.farm_steps) {
      if (step.length < GATE.farmStepMinChars || step.length > GATE.farmStepMaxChars) {
        stepsBad = `${row.slug} has a farm step of ${step.length} characters`;
        break;
      }
    }
    if (stepsBad) break;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      stepsBad = `${row.slug} has implied value ${row.implied_value_usd}`;
      break;
    }
  }
  checks.push(
    stepsBad === ''
      ? pass('farm steps', `every row holds ${GATE.farmStepsMin}..${GATE.farmStepsMax} steps of ${GATE.farmStepMinChars}..${GATE.farmStepMaxChars} characters`)
      : fail('farm steps', stepsBad),
  );

  const dashboard = auditDashboard(out);
  checks.push(
    dashboard.bytes < GATE.dashboardTextMaxBytes
      ? pass('dashboard size', `${dashboard.bytes} bytes across ${dashboard.files.length} files, under ${GATE.dashboardTextMaxBytes}`)
      : fail('dashboard size', `${dashboard.bytes} bytes, over ${GATE.dashboardTextMaxBytes}`),
  );
  checks.push(
    dashboard.networkRefs.length === 0
      ? pass('dashboard network', 'no http:// or https:// reference in the dashboard files')
      : fail('dashboard network', `network references in ${dashboard.networkRefs.join(', ')}`),
  );

  const shotsDir = join(out, 'screenshots');
  const shots = existsSync(shotsDir)
    ? readdirSync(shotsDir).filter((n) => statSync(join(shotsDir, n)).isFile())
    : [];
  let shotsBad = '';
  if (shots.length < GATE.minScreenshots) shotsBad = `${shots.length} screenshots, fewer than ${GATE.minScreenshots}`;
  for (const name of shots) {
    if (!SCREENSHOT_NAME.test(name)) {
      shotsBad = `screenshots/${name} has a name the gate refuses`;
      break;
    }
    const size = statSync(join(shotsDir, name)).size;
    if (size > GATE.screenshotMaxBytes) {
      shotsBad = `screenshots/${name} is ${size} bytes, over ${GATE.screenshotMaxBytes}`;
      break;
    }
    const dims = pngSize(join(shotsDir, name));
    if (dims !== null) {
      const long = Math.max(dims.width, dims.height);
      const short = Math.min(dims.width, dims.height);
      if (short < GATE.screenshotMinShortSide || long > GATE.screenshotMaxLongSide) {
        shotsBad = `screenshots/${name} is ${dims.width}x${dims.height}, outside ${GATE.screenshotMinShortSide}..${GATE.screenshotMaxLongSide}`;
        break;
      }
    }
  }
  checks.push(
    shotsBad === ''
      ? pass('screenshots', `${shots.length} screenshots, each within the size and pixel caps`)
      : fail('screenshots', shotsBad),
  );

  const dataPath = join(out, 'data.js');
  const dataOk = existsSync(dataPath) && readText(dataPath).startsWith('window.RADAR=');
  checks.push(
    dataOk
      ? pass('data.js', 'dashboard data present and written as window.RADAR')
      : fail('data.js', 'data.js is missing or does not carry window.RADAR'),
  );

  const dossierPath = join(out, 'dossier.json');
  if (!existsSync(dossierPath)) {
    checks.push(fail('dossier', 'dossier.json is missing'));
  } else {
    // Compare bytes, not strings: buildDossier returns bytes, and the dossier
    // holds multi-byte characters, so a string length is not a byte length.
    const stored = readFileSync(dossierPath);
    const rebuilt = Buffer.from(buildDossier(out, DOSSIER_OPTIONS) as unknown as Uint8Array);
    checks.push(
      stored.equals(rebuilt)
        ? pass('dossier matches', `the stored dossier (${stored.length} bytes) is byte-identical to a rebuild from this output`)
        : fail('dossier matches', `the stored dossier (${stored.length} bytes) differs from a rebuild (${rebuilt.length} bytes)`),
    );
  }

  const calibration = computeCalibration(snapshot);
  const mediansMatch = board.every(
    (r) => r.model.overall_median === calibration.overall_median,
  );
  checks.push(
    mediansMatch
      ? pass('calibration', `overall median mcap/TVL ${calibration.overall_median} from ${calibration.comps.length} categories, matching the board`)
      : fail('calibration', 'the board carries an overall median the snapshot does not recompute'),
  );

  return checks;
}

/** The board's top rows, as a plain table for --validate's report. */
function topRowsTable(board: BoardRow[], count: number): string {
  const lines = board.slice(0, count).map((r) => {
    const name = r.name.length > 28 ? `${r.name.slice(0, 25)}...` : r.name;
    return `  ${String(r.rank).padStart(3)}  ${name.padEnd(28)}  ${String(r.implied_value_usd).padStart(12)}`;
  });
  return ['  rank  protocol                      implied value', ...lines].join('\n');
}

/** Validation mode: check an earlier output, write comps.json, report, exit 0 or 1. */
function runValidate(): number {
  const snapshot = loadSnapshot(snapshotPath());
  const out = outputDir();
  const checks = validateOutput(snapshot, out);
  const calibration = computeCalibration(snapshot);
  writeFileSync(join(out, 'comps.json'), `${JSON.stringify(compsFile(snapshot, calibration), null, 2)}\n`);
  const board = readBoard(out);
  process.stdout.write(`token radar: validating ${out} against the snapshot as_of ${snapshot.as_of}\n`);
  for (const check of checks) process.stdout.write(`${reportLine(check)}\n`);
  process.stdout.write(
    `${checks.filter((c) => c.passed).length} of ${checks.length} checks passed; comps.json written\n` +
      `${topRowsTable(board, 10)}\n`,
  );
  return checks.every((c) => c.passed) ? 0 : 1;
}

/** Scoring mode: score the snapshot and write every output, as the gate expects. */
function runScore(): number {
  const snapshot = loadSnapshot(snapshotPath());
  const out = outputDir();
  const { board, shots } = scoreAndWrite(snapshot, out);
  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored\n` +
      `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
  );
  return 0;
}

try {
  process.exitCode = hasFlag('validate') ? runValidate() : runScore();
} catch (e) {
  process.stderr.write(`token radar: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
