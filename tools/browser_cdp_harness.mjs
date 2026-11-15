// Reusable Headless Chromium CDP Harness & Multi-Entry Arcade ZIP Builder
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import WebSocket from 'ws';
import { crc32Bytes } from '../src/crc32.mjs';
import { createMinimalArcadeTestZip } from '../src/fbneo_arcade_core.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChromiumBinary() {
  const candidates = [
    path.join(
      process.env.ProgramFiles || 'C:\\Program Files',
      'Google\\Chrome\\Application\\chrome.exe'
    ),
    path.join(
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft\\Edge\\Application\\msedge.exe'
    ),
    path.join(
      process.env.ProgramFiles || 'C:\\Program Files',
      'Microsoft\\Edge\\Application\\msedge.exe'
    ),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

export async function createCdpTab(debugPort, targetUrl) {
  const created = await new Promise((resolve, reject) => {
    const u = `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(
      targetUrl
    )}`;
    const req = http.request(u, { method: 'PUT' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });

  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let nextId = 1;
  const pending = new Map();
  const exceptions = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      exceptions.push(d?.exception?.description || d?.text || 'JS Exception');
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description || res.exceptionDetails.text
      );
    }
    return res.result?.value;
  };

  return { ws, evaluate, exceptions, close: () => ws.close() };
}

export async function waitFor(fn, timeoutMs = 25000, label = 'condition') {
  const t0 = Date.now();
  let lastVal = null;
  while (Date.now() - t0 < timeoutMs) {
    lastVal = await fn();
    if (lastVal) return lastVal;
    await sleep(80);
  }
  throw new Error(
    `Timeout waiting for ${label} (last=${JSON.stringify(lastVal)})`
  );
}

export function startRemoteProxy(targetPort) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((client) => {
      const upstream = net.connect(targetPort, '127.0.0.1');
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.2', () => resolve({
      port: srv.address().port,
      close: () => new Promise((r) => srv.close(() => r()))
    }));
  });
}

export async function launchHeadlessBrowser(binPath, userDataDir) {
  const proc = spawn(binPath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  const debugPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Chrome launch timeout: ${stderr}`)), 12000
    );
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}): ${stderr}`));
    });
  });
  await waitFor(() => httpJson(`http://127.0.0.1:${debugPort}/json/version`)
    .catch(() => null), 5000, 'CDP ready');
  return { proc, debugPort };
}

export function buildMultiSliceArcadeZipBase64(padBytes = 290000) {
  const miniZip = createMinimalArcadeTestZip();
  const romData = miniZip.subarray(30 + 10, 30 + 10 + 8192);
  const padData = new Uint8Array(padBytes);
  for (let i = 0; i < padBytes; i++) padData[i] = (i * 131 + 17) & 0xff;
  const entries = [
    { name: new TextEncoder().encode('d26-01.ic7'), data: romData },
    { name: new TextEncoder().encode('readme.dat'), data: padData }
  ];
  let dataLen = 0, cdLen = 0;
  for (const e of entries) {
    e.crc = crc32Bytes(e.data) >>> 0;
    e.offset = dataLen;
    dataLen += 30 + e.name.length + e.data.length;
    cdLen += 46 + e.name.length;
  }
  const out = new Uint8Array(dataLen + cdLen + 22);
  const dv = new DataView(out.buffer);
  for (const e of entries) {
    const p = e.offset;
    dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true);
    dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.data.length, true);
    dv.setUint32(p + 22, e.data.length, true);
    dv.setUint16(p + 26, e.name.length, true);
    out.set(e.name, p + 30); out.set(e.data, p + 30 + e.name.length);
  }
  let cd = dataLen;
  for (const e of entries) {
    dv.setUint32(cd, 0x02014b50, true); dv.setUint16(cd + 4, 20, true);
    dv.setUint16(cd + 6, 20, true); dv.setUint32(cd + 16, e.crc, true);
    dv.setUint32(cd + 20, e.data.length, true);
    dv.setUint32(cd + 24, e.data.length, true);
    dv.setUint16(cd + 28, e.name.length, true);
    dv.setUint32(cd + 42, e.offset, true);
    out.set(e.name, cd + 46);
    cd += 46 + e.name.length;
  }
  dv.setUint32(cd, 0x06054b50, true);
  dv.setUint16(cd + 8, entries.length, true);
  dv.setUint16(cd + 10, entries.length, true);
  dv.setUint32(cd + 12, cdLen, true);
  dv.setUint32(cd + 16, dataLen, true);
  return Buffer.from(out).toString('base64');
}
