// Builds the phone versions of DataStrap from the desktop dashboard plus the
// phone-side modules in src/.
//
//   node build.mjs            Android app → www/, with seed.json from this
//                             computer's data when the desktop setup exists
//   node build.mjs --no-seed  Android app without seed.json
//   node build.mjs --web      Web app (iPhone home screen, any browser) → web/
//                             Google client ID from web.config.json or the
//                             DATASTRAP_GOOGLE_CLIENT_ID environment variable
//
// www/ and web/ are build output and gitignored (seed.json is personal data).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const WEB = process.argv.includes('--web');
const out = join(here, WEB ? 'web' : 'www');
const MODULES = ['engine.js', 'ingest.js', 'store.js', 'google.js', 'webauth.js', 'mobile.js', 'mobile.css'];

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'm'), { recursive: true });
for (const f of ['styles.css', 'icons.js', 'app.js']) cpSync(join(root, f), join(out, f));
for (const f of MODULES) cpSync(join(here, 'src', f), join(out, 'm', f));

let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html.replace(/(<link rel="stylesheet" href="styles\.css[^"]*">)/, '$1\n  <link rel="stylesheet" href="m/mobile.css">');

// config.json: the web app's Google client ID, and (both builds) where the
// in-app feedback goes. Neither is a secret.
const fileConfig = existsSync(join(here, 'web.config.json')) ? JSON.parse(readFileSync(join(here, 'web.config.json'), 'utf8')) : {};
const appConfig = {
  googleClientId: WEB ? (process.env.DATASTRAP_GOOGLE_CLIENT_ID || fileConfig.googleClientId || '') : '',
  feedback: fileConfig.feedback || null,
};

if (WEB) {
  // Takeout import (only loaded when used) and its unzip library (MIT).
  cpSync(join(here, 'src', 'takeout.js'), join(out, 'm', 'takeout.js'));
  cpSync(join(here, 'node_modules', 'fflate', 'esm', 'browser.js'), join(out, 'm', 'fflate.js'));
  cpSync(join(here, 'src', 'icons'), join(out, 'icons'), { recursive: true });

  const version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim() + '-' + Date.now().toString(36);
  writeFileSync(join(out, 'sw.js'), readFileSync(join(here, 'src', 'sw.js'), 'utf8').replace('__VERSION__', version));

  if (!appConfig.googleClientId) console.warn('Warning: no Google client ID (web.config.json); sign-in will show an error.');

  writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
    name: 'DataStrap',
    short_name: 'DataStrap',
    description: 'Your Fitbit data: recovery, strain, sleep and more, worked out on your phone.',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#050506',
    theme_color: '#050506',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2));

  html = html
    .replace('<meta name="theme-color" content="#050506">', [
      '<meta name="theme-color" content="#050506">',
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
      '<meta name="apple-mobile-web-app-title" content="DataStrap">',
      '<link rel="manifest" href="manifest.webmanifest">',
      '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
      '<link rel="icon" type="image/png" href="icons/favicon-32.png">',
    ].join('\n  '))
    .replace(/(<script src="app\.js[^"]*"><\/script>)/, '<script type="module" src="m/mobile.js"></script>\n  $1');
} else {
  // Capacitor's JS runtime (registerPlugin etc.); the native side only injects the bridge.
  cpSync(join(here, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'), join(out, 'm', 'capacitor.js'));
  html = html.replace(/(<script src="app\.js[^"]*"><\/script>)/, '<script src="m/capacitor.js"></script>\n  <script type="module" src="m/mobile.js"></script>\n  $1');
}
if (!html.includes('m/mobile.js')) throw new Error('index.html changed shape: could not add the mobile scripts');
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, 'config.json'), JSON.stringify(appConfig));

const python = join(root, '.venv', 'bin', 'python');
if (!WEB && !process.argv.includes('--no-seed') && existsSync(python) && existsSync(join(root, 'profile.json'))) {
  console.log('Building seed.json from this computer’s data…');
  execFileSync(python, [join(here, 'make_seed.py'), join(out, 'seed.json')], { stdio: ['ignore', 'ignore', 'inherit'] });
}
console.log(`${WEB ? 'web' : 'www'} ready${existsSync(join(out, 'seed.json')) ? ' (with seed.json)' : ''}`);
