// Prego's desktop app: starts the Prego server with Electron's own Node, on a free port on this
// computer only, and shows the GUI in a window. Quitting the app stops the server.
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createWriteStream, mkdirSync } = require('node:fs');
const { createServer } = require('node:net');
const { join } = require('node:path');

const SERVER = join(__dirname, 'packages', 'server', 'dist', 'main.js');
const dataDir = process.env.PREGO_DATA_DIR || join(app.getPath('userData'), 'data');
let server;
let origin;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  mkdirSync(dataDir, { recursive: true });
  const log = createWriteStream(join(app.getPath('userData'), 'prego.log'), { flags: 'a' });
  server = spawn(process.execPath, [SERVER], {
    // Electron's binary runs as plain Node. Children (such as the journey recorder) inherit this.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', PREGO_PORT: String(port), PREGO_OPEN: '0', PREGO_DATA_DIR: dataDir },
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Prego's server stopped (code ${server.exitCode}). See ${join(app.getPath('userData'), 'prego.log')}.`);
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Prego’s server didn’t start within a minute.');
}

function openWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Prego',
    backgroundColor: '#0e1022',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Links to anything other than Prego itself (audited sites, help pages) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(origin)) shell.openExternal(url);
    return { action: url.startsWith(origin) ? 'allow' : 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.loadURL(`${origin}/`);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { label: 'Data', submenu: [{ label: 'Show data folder', click: () => shell.openPath(dataDir) }] },
      { role: 'windowMenu' },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      await startServer();
    } catch (error) {
      dialog.showErrorBox('Prego couldn’t start', error instanceof Error ? error.message : String(error));
      app.quit();
      return;
    }
    // A check used after packaging: start, confirm the GUI loads, and quit without showing a window.
    if (process.env.PREGO_DESKTOP_SMOKE === '1') {
      const page = await (await fetch(`${origin}/`)).text();
      console.log(page.includes('<div id="root">') ? `PREGO_DESKTOP_OK ${origin}` : 'PREGO_DESKTOP_FAILED');
      app.quit();
      return;
    }
    buildMenu();
    openWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openWindow();
    });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('quit', () => server?.kill('SIGTERM'));
}
