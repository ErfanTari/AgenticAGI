import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const templatesDir = path.join(projectRoot, 'apps', 'macos', 'templates');
const buildDir = path.join(projectRoot, 'apps', 'macos', 'build');
const replacements = {
  __NODE_PATH__: process.execPath,
  __PROJECT_ROOT__: projectRoot,
};

const apps = [
  {
    bundleName: 'AgenticAGI Launcher',
    executableName: 'AgenticAGI Launcher',
    bundleId: 'com.agenticagi.launcher',
    template: 'AgenticAGI Launcher.zsh',
  },
  {
    bundleName: 'Stop AgenticAGI',
    executableName: 'Stop AgenticAGI',
    bundleId: 'com.agenticagi.stop-launcher',
    template: 'Stop AgenticAGI.zsh',
  },
];

function renderTemplate(source) {
  return Object.entries(replacements).reduce(
    (result, [token, value]) => result.replaceAll(token, value),
    source,
  );
}

function createInfoPlist(app) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${app.bundleName}</string>
  <key>CFBundleExecutable</key>
  <string>${app.executableName}</string>
  <key>CFBundleIdentifier</key>
  <string>${app.bundleId}</string>
  <key>CFBundleName</key>
  <string>${app.bundleName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });

for (const app of apps) {
  const bundleDir = path.join(buildDir, `${app.bundleName}.app`);
  const contentsDir = path.join(bundleDir, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const templatePath = path.join(templatesDir, app.template);
  const executablePath = path.join(macOsDir, app.executableName);
  const infoPlistPath = path.join(contentsDir, 'Info.plist');
  const renderedExecutable = renderTemplate(fs.readFileSync(templatePath, 'utf-8'));

  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(macOsDir, { recursive: true });
  fs.writeFileSync(executablePath, renderedExecutable, 'utf-8');
  fs.chmodSync(executablePath, 0o755);
  fs.writeFileSync(infoPlistPath, createInfoPlist(app), 'utf-8');
  fs.writeFileSync(path.join(contentsDir, 'PkgInfo'), 'APPL????', 'utf-8');
  console.log(`Built ${bundleDir}`);
}
