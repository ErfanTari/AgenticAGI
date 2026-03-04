import { transparency, type TransparencyEvent } from './transparency.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
};

const c = (color: keyof typeof C, text: string) => `${C[color]}${text}${C.reset}`;

function render(event: TransparencyEvent): string {
  switch (event.type) {
    case 'intent':
      return (
        c('cyan', '\n┌─ INTENT') +
        `\n│  intent:   ${c('bold', event.data.intent)}` +
        `\n│  notebook: ${event.data.nb ?? '—'}` +
        `\n│  type:     ${event.data.type ?? '—'}` +
        `\n│  skill:    ${event.data.skill ?? '—'}` +
        `\n│  codes:    ${event.data.codes?.join(', ') || '—'}` +
        c('cyan', '\n└─────────────────')
      );

    case 'complexity': {
      const icon = event.data.isComplex ? c('red', '● COMPLEX') : c('green', '● SIMPLE');
      return (
        c('yellow', '\n┌─ COMPLEXITY ') +
        icon +
        `\n│  reason: ${event.data.reason}` +
        `\n│  steps:  ${event.data.estimatedSteps}` +
        `\n│  skills: ${event.data.requiresSkills?.join(', ') || '—'}` +
        c('yellow', '\n└─────────────────')
      );
    }

    case 'plan': {
      const steps = event.data.steps
        .map((s: any, i: number) => {
          let line = `\n│  ${i + 1}. [${c('magenta', s.skill)}] ${s.description}`;
          if (s.dependsOn?.length) {
            line += c('dim', ` → needs: ${s.dependsOn.join(', ')}`);
          }
          if (s.optional) {
            line += c('dim', ' (optional)');
          }
          if (s.storeResultAs) {
            line += c('dim', ` → stores: ${s.storeResultAs}`);
          }
          return line;
        })
        .join('');
      return (
        c('magenta', `\n┌─ PLAN (${event.data.steps.length} steps)`) +
        `\n│  goal: ${event.data.goal}` +
        steps +
        c('magenta', '\n└─────────────────')
      );
    }

    case 'step_start':
      return c('blue', `\n  ▶ [${event.data.step.skill}]`) + ` ${event.data.step.description}`;

    case 'step_result': {
      const ok = event.data.result.success;
      const tick = ok ? c('green', '✓') : c('red', '✗');
      const out = (event.data.result.output?.slice(0, 150) ?? '').trim();
      const err = event.data.result.error ?? '';
      return `  ${tick} ${c('dim', `${event.data.ms}ms`)}` + (ok ? c('dim', ` → ${out}`) : c('red', ` ERROR: ${err}`));
    }

    case 'llm_request': {
      const last = event.data.messages.at(-1);
      const preview = last?.content?.slice(0, 200) ?? '';
      const sysPreview = event.data.system?.slice(0, 120) ?? '';
      return (
        c('white', '\n┌─ LLM REQUEST') +
        `\n│  system:  ${c('dim', sysPreview + '...')}` +
        `\n│  msgs:    ${event.data.messages.length}` +
        `\n│  last:    ${c('dim', preview + '...')}` +
        (event.data.schema ? `\n│  schema:  YES` : '') +
        c('white', '\n└─────────────────')
      );
    }

    case 'llm_raw': {
      const hasThink = /<think>|Thinking Process:/i.test(event.data.raw);
      const rawPrev = event.data.raw.slice(0, 600);
      return (
        c('red', '\n┌─ LLM RAW') +
        c('dim', ` (${event.data.ms}ms)`) +
        (hasThink ? c('red', ' ⚠ THINKING DETECTED') : '') +
        `\n${c('dim', rawPrev)}` +
        (event.data.raw.length > 600 ? c('dim', `\n... ${event.data.raw.length} chars total`) : '') +
        c('red', '\n└─────────────────')
      );
    }

    case 'llm_stripped': {
      const strPrev = event.data.stripped.slice(0, 400);
      return (
        c('green', '\n┌─ LLM STRIPPED') +
        `\n${c('dim', strPrev)}` +
        (event.data.stripped.length > 400 ? c('dim', `\n... ${event.data.stripped.length} chars`) : '') +
        c('green', '\n└─────────────────')
      );
    }

    case 'memory_query':
      return (
        c('cyan', '  ◆ MEMORY') +
        ` "${event.data.query}"` +
        (event.data.nb ? ` [${event.data.nb}]` : '') +
        c('dim', ` → ${event.data.results} results`)
      );

    case 'memory_write':
      return (
        c('green', '  ◆ MEMORY WRITE') +
        ` ${event.data.code} — ${event.data.name}` +
        c('dim', ` [${event.data.nb}]`)
      );

    case 'context_built':
      return c(
        'dim',
        `  ◆ CONTEXT ${event.data.tokens} tokens` +
          ` [${event.data.sections.join(', ')}]`
      );

    case 'heartbeat':
      return (
        c('yellow', '\n┌─ HEARTBEAT') +
        `\n│  checks:   ${event.data.checks.join(', ')}` +
        `\n│  findings: ${event.data.findings}` +
        c('yellow', '\n└─────────────────')
      );

    case 'error':
      return c('red', `\n⚠ ERROR [${event.data.source}]`) + ` ${event.data.error}`;

    default:
      return '';
  }
}

export function attachConsoleRenderer(filter?: TransparencyEvent['type'][]) {
  return transparency.on(event => {
    if (filter && !filter.includes(event.type)) return;
    const line = render(event);
    if (line) process.stderr.write(line + '\n');
  });
}
