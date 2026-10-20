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
// www/ and web/ are build output and gitignored (seed.json and portrait.webp
// are personal data).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const WEB = process.argv.includes('--web');
const out = join(here, WEB ? 'web' : 'www');
const MODULES = ['engine.js', 'ingest.js', 'store.js', 'google.js', 'webauth.js', 'mobile.js', 'mobile.css', 'takeout.js', 'portrait.js'];

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'm'), { recursive: true });
for (const f of ['styles.css', 'icons.js', 'app.js', 'placeholder-man.webp', 'placeholder-woman.webp']) cpSync(join(root, f), join(out, f));
for (const f of MODULES) cpSync(join(here, 'src', f), join(out, 'm', f));
// Takeout import (VO₂ max, only loaded when used) needs its unzip library (MIT).
cpSync(join(here, 'node_modules', 'fflate', 'esm', 'browser.js'), join(out, 'm', 'fflate.js'));

let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html.replace(/(<link rel="stylesheet" href="styles\.css[^"]*">)/, '$1\n  <link rel="stylesheet" href="m/mobile.css">');

// config.json: the web app's Google client ID, and (both builds) where the
// in-app feedback goes. Neither is a secret.
const fileConfig = existsSync(join(here, 'web.config.json')) ? JSON.parse(readFileSync(join(here, 'web.config.json'), 'utf8')) : {};
const appConfig = {
  googleClientId: WEB ? (process.env.DATASTRAP_GOOGLE_CLIENT_ID || fileConfig.googleClientId || '') : '',
  feedback: fileConfig.feedback || null,
  // Sign-in helper (token-server/) for long-lasting web sign-in; optional.
  tokenServer: WEB ? (fileConfig.tokenServer || null) : null,
  // Same helper, both builds: makes the optional Today portrait (POST /portrait).
  portraitServer: fileConfig.portraitServer || fileConfig.tokenServer || null,
};

if (WEB) {
  cpSync(join(here, 'src', 'icons'), join(out, 'icons'), { recursive: true });
  // Privacy policy and terms, linked from the Google sign-in consent screen.
  cpSync(join(here, 'policy'), out, { recursive: true });

  const version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim() + '-' + Date.now().toString(36);
  writeFileSync(join(out, 'sw.js'), readFileSync(join(here, 'src', 'sw.js'), 'utf8').replace('__VERSION__', version));

  if (!appConfig.googleClientId) console.warn('Warning: no Google client ID (web.config.json); sign-in will show an error.');

  writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
    name: 'DataStrap',
    short_name: 'DataStrap',
    description: 'Your health data: recovery, strain, sleep and more, worked out on your phone.',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#0A0A0B',
    theme_color: '#0A0A0B',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2));

  html = html
    .replace('<meta name="theme-color" content="#0A0A0B">', [
      '<meta name="theme-color" content="#0A0A0B">',
      '<meta name="google-site-verification" content="G4N7W8UV2TrkiwGzqEbMfv3hft80QxgpQGKX02Dfopw" />',
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
      '<meta name="apple-mobile-web-app-title" content="DataStrap">',
      '<link rel="manifest" href="manifest.webmanifest">',
      '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
      '<link rel="icon" type="image/png" href="icons/favicon-32.png">',
    ].join('\n  '))
    .replace(/(<script src="app\.js[^"]*"><\/script>)/, `<script type="module" src="m/mobile.js?b=${version}"></script>\n  $1`)
    .replace('href="m/mobile.css"', `href="m/mobile.css?b=${version}"`);
  // Same build stamp on the module imports, so a new version never mixes
  // with cached old modules.
  for (const f of ['mobile.js', 'google.js', 'ingest.js', 'engine.js', 'store.js', 'webauth.js', 'takeout.js']) {
    const path = join(out, 'm', f);
    if (existsSync(path)) writeFileSync(path, readFileSync(path, 'utf8').replace(/(from\s+|import\()(['"])\.\/([a-z]+\.js)\2/g, `$1$2./$3?b=${version}$2`));
  }
} else {
  // Capacitor's JS runtime (registerPlugin etc.); the native side only injects the bridge.
  cpSync(join(here, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'), join(out, 'm', 'capacitor.js'));
  html = html.replace(/(<script src="app\.js[^"]*"><\/script>)/, '<script src="m/capacitor.js"></script>\n  <script type="module" src="m/mobile.js"></script>\n  $1');
}
if (!html.includes('m/mobile.js')) throw new Error('index.html changed shape: could not add the mobile scripts');

// Content Security Policy: only the app's own scripts run, and the page can
// only talk to Google's APIs and the addresses in config.json. If something
// ever slipped markup into a page, it couldn't load code or send data elsewhere.
const origin = u => { try { return new URL(u).origin; } catch { return null; } };
const connect = new Set(["'self'", 'https://health.googleapis.com', 'https://www.googleapis.com', 'https://oauth2.googleapis.com',
  ...[appConfig.tokenServer, appConfig.portraitServer, appConfig.feedback && appConfig.feedback.formUrl].map(origin).filter(Boolean)]);
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // style="" attributes in drawn markup
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  `connect-src ${[...connect].join(' ')}`,
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');
html = html.replace('<meta charset="UTF-8">', `<meta charset="UTF-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
if (!html.includes('Content-Security-Policy')) throw new Error('index.html changed shape: could not add the Content Security Policy');
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, 'config.json'), JSON.stringify(appConfig));

const python = join(root, '.venv', 'bin', 'python');
if (!WEB && !process.argv.includes('--no-seed') && existsSync(python) && existsSync(join(root, 'profile.json'))) {
  console.log('Building seed.json from this computer’s data…');
  execFileSync(python, [join(here, 'make_seed.py'), join(out, 'seed.json')], { stdio: ['ignore', 'ignore', 'inherit'] });
}
// Personal portrait for the Today hero (git-ignored). Android builds only:
// the web app is public, so it never gets it.
if (!WEB && !process.argv.includes('--no-seed') && existsSync(join(root, 'portrait.webp'))) {
  cpSync(join(root, 'portrait.webp'), join(out, 'portrait.webp'));
}
console.log(`${WEB ? 'web' : 'www'} ready${existsSync(join(out, 'seed.json')) ? ' (with seed.json)' : ''}${existsSync(join(out, 'portrait.webp')) ? ' (with portrait)' : ''}`);
