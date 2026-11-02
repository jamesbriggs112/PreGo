// Builds Prego.app: a self-contained copy of Prego (built engine, server and GUI, with production
// dependencies) inside an Electron app. Run from the repository root: npm run desktop:build
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const stage = join(here, 'build', 'app');
const out = join(here, 'out');
const desktop = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const electronVersion = desktop.devDependencies.electron;
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

console.log('▸ Building Prego');
run('npm', ['run', 'build'], root);

console.log('▸ Copying the built app');
rmSync(join(here, 'build'), { recursive: true, force: true });
const copy = (path) => cpSync(join(root, path), join(stage, path), { recursive: true });
for (const path of ['packages/core/package.json', 'packages/core/dist', 'packages/core/vendor', 'packages/server/package.json', 'packages/server/dist', 'packages/web/dist', 'config', 'stubs', 'patches']) copy(path);
cpSync(join(here, 'main.cjs'), join(stage, 'main.cjs'));
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'prego',
      productName: 'Prego',
      version: rootPackage.version,
      private: true,
      description: rootPackage.description,
      license: rootPackage.license,
      main: 'main.cjs',
      workspaces: ['packages/core', 'packages/server'],
      scripts: { postinstall: 'patch-package' },
      dependencies: { '@prego/server': rootPackage.version, 'patch-package': rootPackage.devDependencies['patch-package'] },
      overrides: rootPackage.overrides,
      allowScripts: rootPackage.allowScripts,
    },
    null,
    2,
  ),
);
// Same dependency versions as the main install.
cpSync(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));

console.log('▸ Installing production dependencies');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], stage);

console.log(`▸ Rebuilding native modules for Electron ${electronVersion}`);
run(join(here, 'node_modules', '.bin', 'electron-rebuild'), ['--version', electronVersion, '--module-dir', stage, '--only', 'better-sqlite3', '--force'], here);

console.log('▸ Making the app icon');
const iconset = join(here, 'build', 'Prego.iconset');
mkdirSync(iconset, { recursive: true });
const svg = readFileSync(join(root, 'packages', 'web', 'public', 'favicon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg', '<svg width="1024" height="1024"')}</body></html>`);
const master = join(here, 'build', 'icon-1024.png');
await page.screenshot({ path: master, omitBackground: true });
await browser.close();
for (const size of [16, 32, 128, 256, 512]) {
  run('sips', ['-z', String(size), String(size), master, '--out', join(iconset, `icon_${size}x${size}.png`)], here);
  run('sips', ['-z', String(size * 2), String(size * 2), master, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], here);
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(here, 'build', 'Prego.icns')], here);

console.log('▸ Packaging Prego.app');
const { packager } = await import('@electron/packager');
const [appPath] = await packager({
  dir: stage,
  out,
  name: 'Prego',
  platform: 'darwin',
  arch: process.arch,
  electronVersion,
  appBundleId: 'agency.four.prego',
  appCategoryType: 'public.app-category.developer-tools',
  icon: join(here, 'build', 'Prego.icns'),
  // The server reads its files and starts child processes, so they stay as ordinary files.
  asar: false,
  prune: false,
  overwrite: true,
  quiet: true,
});
console.log(`\nBuilt ${join(appPath, 'Prego.app')}`);
