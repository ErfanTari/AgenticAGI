import { callLLM } from '../../llm.js';
import { fetchByCode, queryEntries } from '../../memory/mod.js';
import type { Message } from '../../types.js';
import type { MCPSkill, SkillResult } from '../types.js';

function parseMaxTokens(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 2000;
  // Allow up to 4096 — models that write analysis preambles need headroom for actual content
  return Math.min(Math.floor(n), 4096);
}

// Detect whether the text starts with a reasoning/analysis preamble block.
// Signals: "Thinking Process:", numbered analysis steps ("1. **Analyze**"), or
// bullet-structured task breakdowns ("* **Task:**").
function startsWithPreamble(text: string): boolean {
  const firstNonEmpty = text.split('\n').find(l => l.trim())?.trim() ?? '';
  return (
    /^(thinking\s+process\s*:?|let me think|analysis:|reasoning:|step\s+\d+[\s\-—])/i.test(firstNonEmpty) ||
    /^\d+\.\s+\*\*/.test(firstNonEmpty) ||
    /^\*\s+\*\*(task|input|constraint|format|output|objective|goal)\b/i.test(firstNonEmpty)
  );
}

// Find the index of the first line that looks like real report content:
// a markdown heading (#), a table (|), or a non-empty non-analysis line
// that comes after we've exited the preamble block.
function stripPreamble(text: string): string {
  if (!startsWithPreamble(text)) return text;

  const lines = text.split('\n');

  // Strategy: scan forward looking for a markdown heading (#).
  // The real report almost always starts with a heading like "# Weekly Status Report".
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line)) {
      return lines.slice(i).join('\n').trim();
    }
  }

  // Fallback: look for the first line that isn't clearly preamble/analysis.
  // Skip lines matching numbered-analysis, bullet-analysis, indented continuations, or empty.
  const SKIP_LINE = /^(\s*$|\d+\.\s|\*\s+\*\*|[\*\-]\s{2}|\s{2,}|thinking|let me|analysis|reasoning|self.?correct|wait,|actually,|constraint|input data|objectives?:)/i;
  for (let i = 0; i < lines.length; i++) {
    if (!SKIP_LINE.test(lines[i])) {
      return lines.slice(i).join('\n').trim();
    }
  }

  return text; // nothing matched — return as-is
}

function stripFormatting(text: string): string {
  let out = text.trim();
  // Strip XML-style thinking tags (DeepSeek R1, Kimi, etc.)
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Strip code fences
  if (out.startsWith('```')) {
    out = out.replace(/^```[a-zA-Z0-9_-]*\n?/, '');
    out = out.replace(/\n?```$/, '');
  }

  // Strip plain-text reasoning preambles (e.g. "Thinking Process:\n1. **Analyze...**")
  out = stripPreamble(out);

  return out.trim();
}

function expectsHtml(prompt: string): boolean {
  return /\b(html|website|web page|portfolio)\b/i.test(prompt);
}

function isPortfolioPrompt(prompt: string): boolean {
  return /\bportfolio\b/i.test(prompt);
}

function expectsLargeContent(prompt: string): boolean {
  return /\b(html|css|javascript|js|complete|full|single.?file|website|web ?page|portfolio)\b/i.test(prompt);
}

interface MemoryEntrySnapshot {
  code?: string;
  nb?: string;
  type?: string;
  name?: string;
  summary?: string;
  content?: string;
}

function extractJsonObjectWithEntries(text: string): string | null {
  const start = text.indexOf('{"count":');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseMemoryEntries(prompt: string): MemoryEntrySnapshot[] {
  const jsonBlock = extractJsonObjectWithEntries(prompt);
  if (!jsonBlock) return [];

  try {
    const parsed = JSON.parse(jsonBlock) as { entries?: MemoryEntrySnapshot[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function loadEntriesFromIndexFallback(): MemoryEntrySnapshot[] {
  const entries: MemoryEntrySnapshot[] = [];

  const who = queryEntries({ nb: 'WHO' })
    .sort((a, b) => a.code.localeCompare(b.code))
    .slice(0, 1);

  const what = queryEntries({ nb: 'WHAT' }).slice(0, 6);
  const merged = [...who, ...what];

  for (const entry of merged) {
    const fetched = fetchByCode(entry.code);
    entries.push({
      code: entry.code,
      nb: entry.nb,
      type: entry.type,
      name: entry.name,
      summary: entry.summary,
      content: fetched?.content,
    });
  }

  return entries;
}

function extractEmail(entries: MemoryEntrySnapshot[]): string {
  for (const entry of entries) {
    if (typeof entry.content !== 'string') continue;
    const match = entry.content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return match[0];
  }
  return 'contact@example.com';
}

function collectSkills(entries: MemoryEntrySnapshot[]): string[] {
  const skills: string[] = [];

  for (const entry of entries) {
    const text = `${entry.name ?? ''} ${entry.summary ?? ''}`.toLowerCase();
    if (text.includes('agentic')) skills.push('Agentic AI Workflows');
    if (text.includes('react')) skills.push('React + TypeScript');
    if (text.includes('node')) skills.push('Node.js APIs');
    if (text.includes('calibration') || text.includes('icc') || text.includes('argyll')) skills.push('Color Calibration Systems');
    if (text.includes('llm') || text.includes('embedding')) skills.push('Local LLM Evaluation');
  }

  const unique = [...new Set(skills)];
  if (unique.length === 0) {
    return ['AI Product Engineering', 'TypeScript Development', 'Systems Planning'];
  }
  return unique.slice(0, 6);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPortfolioFallback(prompt: string): string | null {
  if (!isPortfolioPrompt(prompt)) return null;

  const parsedEntries = parseMemoryEntries(prompt);
  const entries = parsedEntries.length > 0 ? parsedEntries : loadEntriesFromIndexFallback();
  if (entries.length === 0) return null;

  const whoEntry = entries.find(entry => entry.nb === 'WHO' && /\berfan\b/i.test(entry.name ?? ''))
    ?? entries.find(entry => entry.nb === 'WHO')
    ?? entries[0];

  const projectEntries = entries
    .filter(entry => entry.nb === 'WHAT')
    .slice(0, 6);

  const name = whoEntry?.name?.trim() || 'Portfolio Owner';
  const title = (whoEntry?.summary?.replace(/^[Cc]ontact entry for\s+/i, '').trim() || 'Independent Builder');
  const bio = `Building practical AI systems and workflow automation with a focus on reliable execution, clear architecture, and measurable outcomes. Recent work includes ${projectEntries.map(p => p.name).filter(Boolean).slice(0, 2).join(' and ') || 'agentic platform development'}.`;
  const email = extractEmail(entries);
  const skills = collectSkills(entries);

  const projectCards = projectEntries.map(project => {
    const projectName = escapeHtml(project.name ?? 'Project');
    const summary = escapeHtml(project.summary ?? 'Project details');
    const code = escapeHtml(project.code ?? '');
    return `<article class="project"><h3>${projectName}</h3><p>${summary}</p><p class="code">${code}</p></article>`;
  }).join('');

  const skillItems = skills.map(skill => `<li>${escapeHtml(skill)}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(name)} - Portfolio</title>
  <style>
    :root { --bg:#0d1117; --panel:#161b22; --text:#e6edf3; --muted:#9aa4b2; --accent:#58a6ff; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--text); background:radial-gradient(circle at top,#1b2330,#0d1117 55%); }
    nav { position:sticky; top:0; background:rgba(13,17,23,.85); backdrop-filter:blur(6px); padding:14px 20px; border-bottom:1px solid #243041; z-index:10; }
    nav ul { list-style:none; display:flex; gap:16px; margin:0; padding:0; flex-wrap:wrap; }
    nav a { color:var(--muted); text-decoration:none; font-size:14px; }
    nav a:hover { color:var(--accent); }
    section { max-width:940px; margin:0 auto; padding:72px 20px; opacity:0; transform:translateY(16px); transition:opacity .45s ease, transform .45s ease; }
    section.visible { opacity:1; transform:none; }
    #hero { padding-top:96px; }
    h1 { margin:0 0 8px; font-size:clamp(30px,5vw,52px); }
    h2 { font-size:clamp(20px,3vw,30px); margin:0 0 18px; }
    .subtitle { color:var(--accent); margin:0 0 16px; font-weight:600; }
    .muted { color:var(--muted); line-height:1.7; }
    .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
    .project, .panel { background:var(--panel); border:1px solid #263347; border-radius:12px; padding:16px; }
    .project h3 { margin:0 0 8px; }
    .project p { margin:0; color:var(--muted); line-height:1.55; }
    .code { margin-top:10px !important; color:var(--accent) !important; font-size:12px; }
    .skills { list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:10px; }
    .skills li { background:#0f1a2a; border:1px solid #2a3c55; color:var(--text); padding:8px 12px; border-radius:999px; font-size:13px; }
    a.email { color:var(--accent); text-decoration:none; font-weight:600; }
    footer { border-top:1px solid #263347; color:var(--muted); text-align:center; padding:22px; font-size:13px; }
  </style>
</head>
<body>
  <nav>
    <ul>
      <li><a href="#hero">Home</a></li>
      <li><a href="#about">About</a></li>
      <li><a href="#projects">Projects</a></li>
      <li><a href="#skills">Skills</a></li>
      <li><a href="#contact">Contact</a></li>
    </ul>
  </nav>

  <section id="hero" class="visible">
    <h1>${escapeHtml(name)}</h1>
    <p class="subtitle">${escapeHtml(title)}</p>
    <p class="muted">Professional portfolio built from indexed memory records and project history.</p>
  </section>

  <section id="about">
    <h2>About</h2>
    <div class="panel"><p class="muted">${escapeHtml(bio)}</p></div>
  </section>

  <section id="projects">
    <h2>Projects</h2>
    <div class="grid">${projectCards || '<article class="project"><h3>Project Snapshot</h3><p class="muted">Portfolio records were loaded from memory and mapped into this page.</p></article>'}</div>
  </section>

  <section id="skills">
    <h2>Skills</h2>
    <ul class="skills">${skillItems}</ul>
  </section>

  <section id="contact">
    <h2>Contact</h2>
    <div class="panel"><p class="muted">Email: <a class="email" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p></div>
  </section>

  <footer>Built as a single self-contained HTML file with embedded CSS and JavaScript.</footer>
  <script>
    const observer = new IntersectionObserver((entries)=>{ for (const e of entries) { if (e.isIntersecting) e.target.classList.add('visible'); } },{threshold:0.15});
    document.querySelectorAll('section').forEach((el)=>observer.observe(el));
  </script>
</body>
</html>`;
}

function extractHtmlDocument(text: string): string | null {
  const withDoctype = text.match(/<!DOCTYPE html>\s*<html[\s\S]*<\/html>/i);
  if (withDoctype) {
    const candidate = withDoctype[0].trim();
    if (/<head[\s>]/i.test(candidate) && /<body[\s>]/i.test(candidate)) {
      return candidate;
    }
  }

  const htmlOnly = text.match(/<html[\s\S]*<\/html>/i);
  if (htmlOnly && htmlOnly.index !== undefined) {
    const before = text.slice(0, htmlOnly.index).trim();
    if (before.length === 0) {
      const candidate = htmlOnly[0].trim();
      if (/<head[\s>]/i.test(candidate) && /<body[\s>]/i.test(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

// ─── Format contract ────────────────────────────────────────────────────────

type ContentFormat = 'markdown' | 'html' | 'plain';

const FORMAT_INSTRUCTIONS: Record<ContentFormat, string> = {
  markdown: 'Output ONLY valid markdown. No HTML tags. No preamble. Start directly with content. Use # for headers, ** for bold.',
  html: 'Output ONLY valid HTML body content or a full HTML document. No markdown. No preamble. Start with a tag, not text.',
  plain: 'Output ONLY plain text. No markdown. No HTML. No preamble. No headers, no bullets, just prose.',
};

// Known HTML structural tag names — excludes single-letter TypeScript generics like <T>, <U>, <K>
const HTML_TAG_PATTERN = new RegExp(
  '<(' +
  'html|head|body|div|span|p|a|br|hr|' +
  'h[1-6]|ul|ol|li|table|tr|td|th|' +
  'section|article|nav|header|footer|' +
  'main|aside|form|input|button|select|' +
  'script|style|link|meta|title|' +
  'strong|em|b|i|u|code|pre|' +
  'blockquote|img|figure|figcaption|' +
  'video|audio|canvas|svg' +
  ')[\\s/>]',
  'i'
);

function validateFormat(content: string, format: ContentFormat): { valid: boolean; reason?: string } {
  if (format === 'markdown') {
    // Strip code blocks first — code legitimately contains < > syntax (generics, HTML examples)
    const withoutCode = content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`\n]+`/g, '');

    if (HTML_TAG_PATTERN.test(withoutCode)) {
      return { valid: false, reason: 'HTML tags found in markdown output' };
    }
  }
  if (format === 'html') {
    if (!/<[a-z][\s\S]*?>/i.test(content)) {
      return { valid: false, reason: 'No HTML tags found in html output' };
    }
  }
  return { valid: true };
}

function inferFormat(prompt: string): ContentFormat {
  if (expectsHtml(prompt)) return 'html';
  if (/\b(\.js|\.ts|\.py|function\s|class\s|const\s|def\s)/i.test(prompt)) return 'plain';
  return 'markdown';
}

// ─── Skill ──────────────────────────────────────────────────────────────────

const contentWriterSkill: MCPSkill = {
  name: 'content_writer',
  description: 'Generate long-form text or code from instructions. Use this before file_writer when output content is large.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Exact content-generation instruction' },
      format: { type: 'string', description: 'Output format: "markdown" | "html" | "plain". REQUIRED — always specify.' },
      style: { type: 'string', description: 'Optional style/tone hint' },
      maxTokens: { type: 'string', description: 'Optional output budget, default 1200, max 4096' },
    },
    required: ['prompt'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) {
      return { success: false, output: '', error: 'Invalid input: prompt is required' };
    }

    // Resolve format — use explicit param, fall back to inference
    const rawFormat = String(input.format ?? '').toLowerCase().trim();
    const format: ContentFormat = (['markdown', 'html', 'plain'] as ContentFormat[]).includes(rawFormat as ContentFormat)
      ? (rawFormat as ContentFormat)
      : inferFormat(prompt);

    const style = String(input.style ?? '').trim();
    const baseTokens = parseMaxTokens(input.maxTokens);
    // Large content (HTML/CSS/JS/full-file): boost to 4000 so thinking models have room for output
    const maxTokens = (baseTokens === 2000 && expectsLargeContent(prompt)) ? 4000 : baseTokens;
    const boundedPrompt = prompt.length > 10000
      ? prompt.slice(0, 10000) + '\n\n[input truncated for generation budget]'
      : prompt;

    const formatInstruction = FORMAT_INSTRUCTIONS[format];

    const messages: Message[] = [
      {
        role: 'system',
        content: `You are a content generation assistant. ${formatInstruction} Do NOT include any analysis, planning, task breakdown, reasoning steps, or meta-commentary. Start directly with the content itself.`,
      },
      {
        role: 'user',
        content: style ? `Style: ${style}\n\nTask:\n${boundedPrompt}` : boundedPrompt,
      },
    ];

    try {
      const response = await callLLM(messages, { maxTokens });

      // DEBUG_DEEP: emit raw response before any stripping
      if (process.env.DEBUG_DEEP === 'true') {
        console.log('[content_writer:DEEP] RAW RESPONSE (first 800 chars):\n' + response.slice(0, 800));
        console.log('[content_writer:DEEP] startsWithPreamble:', startsWithPreamble(response));
      }

      let output = stripFormatting(response);

      // Guard: empty output after stripping is a stripping artifact, not a content failure.
      // Re-prompt with prefix-forcing so the model skips the analysis and starts content directly.
      if (!output || output.length < 10) {
        if (process.env.DEBUG_DEEP === 'true') {
          console.log(`[content_writer:DEEP] output too short after stripping (${output.length} chars) — forcing reprompt`);
        }
        const forceSeed = format === 'html' ? '<!DOCTYPE html>' : format === 'plain' ? '' : '# ';
        const forceMessages: Message[] = [
          {
            role: 'system',
            content: `You are a content generation assistant. ${formatInstruction} Start immediately with the first character of content.`,
          },
          { role: 'user', content: boundedPrompt },
          { role: 'assistant', content: forceSeed },
        ];
        const forceResponse = await callLLM(forceMessages, { maxTokens });
        const forceOutput = stripFormatting(forceSeed + '\n' + forceResponse);
        if (forceOutput && forceOutput.length >= 10) {
          output = forceOutput;
        } else {
          return { success: false, output: '', error: 'content_writer produced only a stripping artifact — model returned analysis instead of content' };
        }
      }

      // Re-prompt if the raw response starts with preamble — model wrote analysis instead of content.
      // Use prefix-forcing: seed the assistant turn with the opening line so the model
      // continues the document directly rather than restarting its analysis.
      if (startsWithPreamble(response)) {
        // Determine prefix-forcing seed based on declared format
        const openingLine =
          format === 'html'     ? '<!DOCTYPE html>' :
          format === 'plain'    ? '' :
          /* markdown */          '# ';
        const repromptMessages: Message[] = [
          {
            role: 'system',
            content: 'You are a content generation assistant. Continue writing the document from exactly where the assistant turn ends. Output ONLY content, no analysis.',
          },
          {
            role: 'user',
            content: boundedPrompt,
          },
          {
            role: 'assistant',
            // Seed the model with the opening line — it will continue from here
            content: openingLine,
          },
        ];
        const repromptResponse = await callLLM(repromptMessages, { maxTokens });
        // The reprompt response is a continuation — prepend the seeded opening line
        const repromptOutput = stripFormatting(openingLine + '\n' + repromptResponse);

        if (process.env.DEBUG_DEEP === 'true') {
          console.log('[content_writer:DEEP] REPROMPT seed:', JSON.stringify(openingLine));
          console.log('[content_writer:DEEP] REPROMPT RAW (first 800 chars):\n' + repromptResponse.slice(0, 800));
          console.log('[content_writer:DEEP] REPROMPT FINAL OUTPUT (first 600 chars):\n' + repromptOutput.slice(0, 600));
          console.log('[content_writer:DEEP] reprompt still preamble:', startsWithPreamble(repromptResponse), '| length used:', repromptOutput.length > output.length ? 'reprompt' : 'original');
        }

        if (!startsWithPreamble(repromptResponse) || repromptOutput.length > output.length) {
          output = repromptOutput;
        }
      }

      // ── HTML-specific repair (extract document if present) ─────────────────
      if (format === 'html') {
        const html = extractHtmlDocument(output);
        if (html) {
          output = html;
        } else {
          const repairMessages: Message[] = [
            {
              role: 'system',
              content: 'Return only one valid HTML5 document. Start with <!DOCTYPE html> and end with </html>. No commentary.',
            },
            { role: 'user', content: boundedPrompt },
            { role: 'assistant', content: output },
            { role: 'user', content: 'Your previous response was not a valid HTML document. Return only the final HTML5 document now.' },
          ];
          const repaired = stripFormatting(await callLLM(repairMessages, { maxTokens: Math.max(maxTokens, 500) }));
          const repairedHtml = extractHtmlDocument(repaired);
          if (repairedHtml) {
            output = repairedHtml;
          } else {
            const fallback = buildPortfolioFallback(boundedPrompt);
            if (!fallback) {
              return { success: false, output: '', error: 'content_writer output did not contain a valid HTML document' };
            }
            output = fallback;
          }
        }
      }

      if (!output) {
        return { success: false, output: '', error: 'content_writer produced empty output' };
      }

      // Reject output that is just a count or number (e.g. "1" or "3")
      if (/^\d+$/.test(output.trim())) {
        return { success: false, output: '', error: 'content_writer returned invalid output (number only, expected content)' };
      }

      // ── Format contract validation + one retry ──────────────────────────────
      const check = validateFormat(output, format);
      if (!check.valid) {
        if (process.env.DEBUG_DEEP === 'true') {
          console.log(`[content_writer:DEEP] Format violation (${format}): ${check.reason} — retrying`);
        }
        const retryMessages: Message[] = [
          {
            role: 'system',
            content: `${formatInstruction} Start immediately with the first character of content. No preamble, no commentary.`,
          },
          { role: 'user', content: boundedPrompt },
          { role: 'assistant', content: output },
          {
            role: 'user',
            content: `Your previous output was invalid: ${check.reason}. Output ONLY ${format} content, nothing else.`,
          },
        ];
        const retried = stripFormatting(await callLLM(retryMessages, { maxTokens }));
        const retryCheck = validateFormat(retried, format);
        if (retryCheck.valid && retried) {
          output = format === 'html' ? (extractHtmlDocument(retried) ?? retried) : retried;
        }
        // If retry also fails: return with warning (non-blocking)
        if (!validateFormat(output, format).valid) {
          return { success: true, output, warning: `Format contract not fully met: ${check.reason}` } as SkillResult & { warning?: string };
        }
      }

      return { success: true, output };
    } catch (err) {
      if (format === 'html') {
        const fallback = buildPortfolioFallback(boundedPrompt);
        if (fallback) return { success: true, output: fallback };
      }
      return { success: false, output: '', error: `content_writer failed: ${String(err)}` };
    }
  },
};

export default contentWriterSkill;
