// Token Launch Radar: the entry program.
//
// Reads the sealed DefiLlama snapshot, scores every genuine pre-token
// protocol with the model in lib/model.ts, and writes the hand-in:
//   board.json    the ranked board (the gate reads this)
//   data.js       the same board, shaped for the dashboard page
//   dashboard/    the static page (index.html, app.css, app.js)
//   screenshots/  the three views of it the judge is shown
//   dossier.json  the judge's reading pack, built by vendor/makefun-board.ts
//
// Node 22, standard library only, no network, deterministic: the same
// snapshot always writes the same bytes. Outside the grader's container,
// MAKEFUN_OUTPUT_DIR stands in for /output and --input points at the
// snapshot file or the directory holding it.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildBoard, buildData, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && process.argv[at + 1] !== undefined) return process.argv[at + 1]!;
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline === undefined ? fallback : inline.slice(name.length + 3);
}

const inputArg = argument('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  process.stderr.write(`token radar: no snapshot at ${snapshotPath} - pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}
const outDir = argument('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const built = buildBoard(snapshot);
const problem = boardIssue(built.rows, snapshot);
if (problem !== null) {
  process.stderr.write(`token radar: the model produced a board the gate refuses: ${problem}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: built.rows })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(buildData(snapshot, built)));

/** Copy a directory's plain files (no dotfiles, no nesting) into the output. */
function copyFlat(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const pageFiles = copyFlat(join(root, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyFlat(join(root, 'screenshots'), join(outDir, 'screenshots'));
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images; the hand-in needs 3 or 4\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: names are letters, digits and . _ -, up to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier goes last: the scorer rebuilds it from this very output and
// compares the bytes, so nothing may be written after it.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: 65_536,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

process.stdout.write(
  `token radar: scanned ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ranked ${built.rows.length} pre-token candidates\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length} images) and dossier.json in ${outDir}\n`,
);
