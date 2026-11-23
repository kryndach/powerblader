// Automated Clean Code Style Checker (80-char line width & 350-line file cap)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const MAX_LINE_WIDTH = 80;
const TARGET_FILE_LINES = 250;
const MAX_FILE_LINES = 350;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'local',
  'logs',
  'vendor'
]);

const IGNORED_FILES = new Set([
  'package-lock.json',
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
  '.prettierrc.json',
  'Dockerfile'
]);

const CHECKED_EXTS = new Set([
  '.mjs',
  '.js',
  '.css',
  '.html',
  '.ps1',
  '.md',
  '.bat'
]);

function isLookupTableFile(relPath) {
  return relPath.endsWith('_tables.mjs') || relPath.endsWith('_fixture.mjs');
}

function isLineWidthExempt(line, relPath) {
  if (isLookupTableFile(relPath)) return true;
  if (/https?:\/\/\S+|file:\/\/\/\S+/i.test(line)) return true;
  if (/d="[^"]{30,}"/.test(line)) return true;
  if (relPath.endsWith('.md') && /^\s*\|.*\|\s*$/.test(line)) return true;
  return false;
}

function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (!IGNORED_FILES.has(entry.name)) {
      const ext = path.extname(entry.name).toLowerCase();
      if (CHECKED_EXTS.has(ext)) {
        out.push(full);
      }
    }
  }
  return out;
}

const files = collectFiles(ROOT_DIR);
const errors = [];
const warnings = [];

for (const file of files) {
  const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const lineCount =
    lines.length > 0 && lines[lines.length - 1] === ''
      ? lines.length - 1
      : lines.length;

  if (!isLookupTableFile(rel)) {
    if (lineCount > MAX_FILE_LINES) {
      errors.push(
        `[FILE_SIZE] ${rel}: ${lineCount} lines ` +
          `(exceeds hard cap ${MAX_FILE_LINES})`
      );
    } else if (lineCount > TARGET_FILE_LINES) {
      warnings.push(
        `[TARGET_SIZE] ${rel}: ${lineCount} lines ` +
          `(target <=${TARGET_FILE_LINES}, cap <=${MAX_FILE_LINES})`
      );
    }
  }

  for (let i = 0; i < lineCount; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE_WIDTH && !isLineWidthExempt(line, rel)) {
      errors.push(
        `[LINE_WIDTH] ${rel}:${i + 1} is ${line.length} chars ` +
          `(max ${MAX_LINE_WIDTH}): ${line.slice(0, 45)}...`
      );
    }
    if (rel.endsWith('.ps1')) {
      for (let c = 0; c < line.length; c++) {
        if (line.charCodeAt(c) > 127) {
          const code = line.charCodeAt(c);
          errors.push(
            `[PS1_ASCII] ${rel}:${i + 1} contains non-ASCII char code ${code}`
          );
          break;
        }
      }
    }
  }
}

console.log(`=== Clean Code Style Check (${files.length} files scanned) ===`);
if (warnings.length > 0) {
  console.log(`Note (${warnings.length} files between 251-350 lines):`);
  for (const w of warnings) console.log('  ' + w);
}
if (errors.length > 0) {
  console.error(`\n[FAIL] Found ${errors.length} style violation(s):`);
  for (const e of errors.slice(0, 35)) console.error('  ' + e);
  if (errors.length > 35) {
    console.error(`  ... and ${errors.length - 35} more.`);
  }
  process.exit(1);
}
console.log(
  `[PASS] All ${files.length} files obey <=80 char width & <=350 line limits!`
);
