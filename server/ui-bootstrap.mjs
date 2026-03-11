import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const runtimeRoot = path.join(projectRoot, '.ui-runtime');
const controlRoot = path.join(projectRoot, '.ui-control');

function transpileFile(sourcePath, outputPath) {
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf-8');
}

function copyTree(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyTree(sourcePath, targetPath);
      continue;
    }

    fs.copyFileSync(sourcePath, targetPath);
  }
}

function transpileTree(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      transpileTree(sourcePath, targetPath);
      continue;
    }

    if (entry.name.endsWith('.ts')) {
      transpileFile(sourcePath, targetPath.replace(/\.ts$/, '.js'));
    }
  }
}

try {
  process.env.UI_PROJECT_ROOT = projectRoot;
  process.env.UI_RUNTIME_ROOT = runtimeRoot;
  process.env.UI_CONTROL_DIR ??= controlRoot;
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  transpileTree(path.join(projectRoot, 'core'), path.join(runtimeRoot, 'core'));
  transpileTree(path.join(projectRoot, 'config'), path.join(runtimeRoot, 'config'));
  transpileTree(path.join(projectRoot, 'server'), path.join(runtimeRoot, 'server'));
  copyTree(path.join(projectRoot, 'public'), path.join(runtimeRoot, 'public'));
  await import(`${pathToFileURL(path.join(runtimeRoot, 'server/ui-server.js')).href}?ts=${Date.now()}`);
} catch (error) {
  console.error('[ui] Bootstrap failed:', error);
  process.exit(1);
}
