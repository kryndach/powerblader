// Static GitHub Pages Bundle Builder (Sub-Path Safe, Zero ROMs/Secrets)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function copyDirRecursive(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  let files = 0, bytes = 0;
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      const sub = copyDirRecursive(s, d);
      files += sub.files; bytes += sub.bytes;
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
      files++;
      bytes += fs.statSync(d).size;
    }
  }
  return { files, bytes };
}

function rewriteRelativePaths(outDir) {
  const jsDir = path.join(outDir, 'js');
  for (const name of fs.readdirSync(jsDir)) {
    if (!name.endsWith('.mjs')) continue;
    const full = path.join(jsDir, name);
    const raw = fs.readFileSync(full, 'utf8');
    const fixed = raw
      .replace(/(['"])\.\.\/\.\.\/src\//g, '$1../src/')
      .replace(/(['"])\/src\//g, '$1../src/');
    if (fixed !== raw) fs.writeFileSync(full, fixed, 'utf8');
  }
  for (const name of fs.readdirSync(outDir)) {
    if (!name.endsWith('.html')) continue;
    const full = path.join(outDir, name);
    const raw = fs.readFileSync(full, 'utf8');
    const fixed = raw
      .replace(/(href|src)=(['"])\/(css|js|vendor)\//g, '$1=$2./$3/');
    if (fixed !== raw) fs.writeFileSync(full, fixed, 'utf8');
  }
}

export function buildGitHubPagesBundle(
  rootDir = ROOT_DIR, outDir = path.join(ROOT_DIR, 'dist-pages')
) {
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const pub = copyDirRecursive(path.join(rootDir, 'public'), outDir);
  const srcOut = path.join(outDir, 'src');
  fs.mkdirSync(srcOut, { recursive: true });
  let srcFiles = 0, srcBytes = 0;
  for (const name of fs.readdirSync(path.join(rootDir, 'src'))) {
    if (!name.endsWith('.mjs')) continue;
    const s = path.join(rootDir, 'src', name);
    const d = path.join(srcOut, name);
    fs.copyFileSync(s, d);
    srcFiles++;
    srcBytes += fs.statSync(d).size;
  }

  const jsnesSrc = path.join(
    rootDir, 'node_modules', 'jsnes', 'dist', 'jsnes.js'
  );
  const vendorOut = path.join(outDir, 'vendor');
  fs.mkdirSync(vendorOut, { recursive: true });
  let extraBytes = 0;
  if (fs.existsSync(jsnesSrc)) {
    const jsnesDst = path.join(vendorOut, 'jsnes.js');
    const patched = fs
      .readFileSync(jsnesSrc, 'utf8')
      .replace('topTileNum - 1 + 256', 'topTileNum + 256');
    fs.writeFileSync(jsnesDst, patched, 'utf8');
    extraBytes = fs.statSync(jsnesDst).size;
  }
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '', 'utf8');
  rewriteRelativePaths(outDir);

  const totalFiles = pub.files + srcFiles + (extraBytes > 0 ? 1 : 0) + 1;
  const totalBytes = pub.bytes + srcBytes + extraBytes;
  return {
    outDir, totalFiles, totalBytes,
    totalMb: Number((totalBytes / (1024 * 1024)).toFixed(2))
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const res = buildGitHubPagesBundle();
  console.log(
    `[OK] Built GitHub Pages bundle -> ${res.outDir} ` +
      `(${res.totalFiles} files, ${res.totalMb} MB, 0 ROMs/secrets)`
  );
}
