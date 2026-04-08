/**
 * Tests for file_writer overwrite guard
 * Verifies: new file creation works, existing file write fails without overwrite:true,
 * existing file write succeeds with overwrite:true
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fileWriter } from '../../core/skills/tools/file_writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace', 'test-file-writer');
const TEST_FILES: string[] = [];

beforeEach(() => {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
});

afterEach(() => {
  // Clean up test files
  for (const file of TEST_FILES) {
    const fullPath = path.join(WORKSPACE_ROOT, file);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }
  TEST_FILES.length = 0;
  // Clean up directory
  if (fs.existsSync(WORKSPACE_ROOT)) {
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
});

describe('file_writer overwrite guard', () => {

  it('T1: writing a new file succeeds', async () => {
    const testFile = 'test-new-file.txt';
    TEST_FILES.push(testFile);

    const result = await fileWriter.execute({
      path: `test-file-writer/${testFile}`,
      content: 'Hello, world!'
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain(testFile);

    // Verify file was created with correct content
    const filePath = path.join(WORKSPACE_ROOT, testFile);
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toBe('Hello, world!');
  });

  it('T2: writing to existing file fails without overwrite:true', async () => {
    const testFile = 'existing-file.txt';
    TEST_FILES.push(testFile);
    const initialContent = 'Original content';

    // Create the file first
    const createResult = await fileWriter.execute({
      path: `test-file-writer/${testFile}`,
      content: initialContent
    });
    expect(createResult.success).toBe(true);

    // Try to write to it without overwrite flag
    const writeResult = await fileWriter.execute({
      path: `test-file-writer/${testFile}`,
      content: 'New content'
    });
    expect(writeResult.success).toBe(false);
    expect(writeResult.error).toContain('File already exists');
    expect(writeResult.error).toContain('patch_file');
    expect(writeResult.error).toContain('overwrite');

    // Verify original content is unchanged
    const filePath = path.join(WORKSPACE_ROOT, testFile);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toBe(initialContent);
  });

  it('T3: writing to existing file succeeds with overwrite:true', async () => {
    const testFile = 'overwrite-test.txt';
    TEST_FILES.push(testFile);
    const initialContent = 'Original content';
    const newContent = 'Completely new content';

    // Create the file first
    const createResult = await fileWriter.execute({
      path: `test-file-writer/${testFile}`,
      content: initialContent
    });
    expect(createResult.success).toBe(true);

    // Now overwrite it with overwrite:true
    const overwriteResult = await fileWriter.execute({
      path: `test-file-writer/${testFile}`,
      content: newContent,
      overwrite: true
    });
    expect(overwriteResult.success).toBe(true);
    expect(overwriteResult.output).toContain(testFile);

    // Verify content was replaced
    const filePath = path.join(WORKSPACE_ROOT, testFile);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toBe(newContent);
  });

});
