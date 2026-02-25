import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileWriter } from '../../core/skills/tools/file_writer.js';
import { runBash } from '../../core/skills/tools/run_bash.js';
import { getSkill } from '../../core/skills/registry.js';

// Test workspace
const TEST_WORKSPACE = path.join(os.tmpdir(), `phase9-skills-${Date.now()}`);

beforeAll(() => {
  // Override workspace for tests
  const originalCwd = process.cwd();
  process.chdir(path.dirname(TEST_WORKSPACE));
  fs.mkdirSync(path.join(path.dirname(TEST_WORKSPACE), 'workspace'), { recursive: true });
});

afterAll(() => {
  // Cleanup
  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  }
  const workspaceDir = path.join(process.cwd(), 'workspace');
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe('Phase 9 Priority 1: file_writer and run_bash skills', () => {
  // --- file_writer tests ---

  describe('file_writer', () => {
    it('writes a file to workspace/', async () => {
      const result = await fileWriter.execute({
        path: 'test.txt',
        content: 'Hello from file_writer',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Written to test.txt');

      const filePath = path.resolve(process.cwd(), 'workspace', 'test.txt');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('Hello from file_writer');
    });

    it('writes to nested directories (auto-creates)', async () => {
      const result = await fileWriter.execute({
        path: 'src/components/Button.tsx',
        content: 'export const Button = () => <button>Click</button>;',
      });

      expect(result.success).toBe(true);

      const filePath = path.resolve(process.cwd(), 'workspace', 'src/components/Button.tsx');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('appends to existing file', async () => {
      await fileWriter.execute({
        path: 'log.txt',
        content: 'Line 1\n',
      });

      const result = await fileWriter.execute({
        path: 'log.txt',
        content: 'Line 2\n',
        mode: 'append',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Appended');

      const filePath = path.resolve(process.cwd(), 'workspace', 'log.txt');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('Line 1\nLine 2\n');
    });

    it('rejects path traversal attempts', async () => {
      const result = await fileWriter.execute({
        path: '../../../etc/passwd',
        content: 'malicious',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });

    it('rejects absolute paths outside workspace', async () => {
      const result = await fileWriter.execute({
        path: '/tmp/badfile.txt',
        content: 'should fail',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });

    it('handles invalid inputs', async () => {
      const result = await fileWriter.execute({
        path: '',
        content: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid input');
    });

    it('registered in skill registry', () => {
      const skill = getSkill('file_writer');
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('file_writer');
      expect(skill?.description).toContain('Write or edit');
    });
  });

  // --- run_bash tests ---

  describe('run_bash', () => {
    it('runs simple bash commands', async () => {
      const result = await runBash.execute({
        command: 'echo "Hello from bash"',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello from bash');
    });

    it('runs commands in workspace directory', async () => {
      const result = await runBash.execute({
        command: 'pwd',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('workspace');
    });

    it('creates files visible to file_writer', async () => {
      await runBash.execute({
        command: 'echo "Created by bash" > bash-file.txt',
      });

      const filePath = path.resolve(process.cwd(), 'workspace', 'bash-file.txt');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('Created by bash');
    });

    it('runs in specified subdirectory', async () => {
      // Create subdirectory
      fs.mkdirSync(path.resolve(process.cwd(), 'workspace', 'subdir'), { recursive: true });

      const result = await runBash.execute({
        command: 'pwd',
        cwd: 'subdir',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('subdir');
    });

    it('blocks dangerous rm -rf / command', async () => {
      const result = await runBash.execute({
        command: 'rm -rf /',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Command not allowed');
      expect(result.error).toContain('rm -rf /');
    });

    it('blocks sudo command', async () => {
      const result = await runBash.execute({
        command: 'sudo apt-get install something',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('sudo');
    });

    it('blocks chmod 777 command', async () => {
      const result = await runBash.execute({
        command: 'chmod 777 file.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chmod 777');
    });

    it('blocks fork bomb pattern', async () => {
      const result = await runBash.execute({
        command: ':(){:|:&};:',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(':(){');
    });

    it('blocks dd command (disk destroyer)', async () => {
      const result = await runBash.execute({
        command: 'dd if=/dev/zero of=/dev/sda',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('dd if=');
    });

    it('rejects path traversal in cwd', async () => {
      const result = await runBash.execute({
        command: 'ls',
        cwd: '../../../etc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });

    it('handles command failures gracefully', async () => {
      const result = await runBash.execute({
        command: 'ls nonexistent-file-xyz.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No such file');
    });

    it('times out long-running commands', async () => {
      const result = await runBash.execute({
        command: 'sleep 35',  // Exceeds 30s timeout
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    }, 35000); // Extend test timeout

    it('registered in skill registry', () => {
      const skill = getSkill('run_bash');
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('run_bash');
      expect(skill?.description).toContain('bash command');
    });
  });

  // --- Integration tests ---

  describe('file_writer + run_bash integration', () => {
    it('file_writer creates file, run_bash reads it', async () => {
      await fileWriter.execute({
        path: 'data.txt',
        content: 'Important data\n',
      });

      const result = await runBash.execute({
        command: 'cat data.txt',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Important data');
    });

    it('run_bash creates file, file_writer appends to it', async () => {
      await runBash.execute({
        command: 'echo "First line" > combined.txt',
      });

      await fileWriter.execute({
        path: 'combined.txt',
        content: 'Second line\n',
        mode: 'append',
      });

      const filePath = path.resolve(process.cwd(), 'workspace', 'combined.txt');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('First line');
      expect(content).toContain('Second line');
    });

    it('complex workflow: write code, run bash to execute', async () => {
      // Write a Node.js script
      await fileWriter.execute({
        path: 'script.js',
        content: 'console.log("Hello from script");',
      });

      // Execute it
      const result = await runBash.execute({
        command: 'node script.js',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello from script');
    });
  });
});
