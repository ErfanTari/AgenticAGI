import { describe, expect, it } from 'vitest';
import { parseXmlAction } from '../../core/utils/xml-parser.js';

describe('parseXmlAction', () => {
  it('parses a normal single action block', () => {
    const parsed = parseXmlAction(
      '<action>file_writer</action>\n<path>demo.txt</path>\n<content>hello</content>',
    );

    expect(parsed).toEqual({
      action: 'file_writer',
      path: 'demo.txt',
      content: 'hello',
    });
  });

  it('uses only the first complete action block when multiple actions are emitted', () => {
    const parsed = parseXmlAction([
      'NEXT STEP: write package.json',
      '<action>generate_and_save_file</action>',
      '<path>outputs/demo/package.json</path>',
      '<description>{"name":"demo"}</description>',
      '<action>run_bash</action>',
      '<command>npm install</command>',
      '<action>list_dir</action>',
      '<path>outputs</path>',
    ].join('\n'));

    expect(parsed).toEqual({
      thought: 'NEXT STEP: write package.json',
      action: 'generate_and_save_file',
      path: 'outputs/demo/package.json',
      description: '{"name":"demo"}',
    });
  });
});
