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
    case 'plan': {
      const milestones = (event.data.milestones ?? [])
        .map((milestone: any, i: number) => {
          const milestoneSteps = milestone.steps
            .map((s: any) => `\n│    • [${c('magenta', s.skill)}] ${s.description}`)
            .join('');
          return `\n│  M${i + 1}. ${milestone.title} ${c('dim', `— ${milestone.completionCriteria}`)}${milestoneSteps}`;
        })
        .join('');
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
        `\n│  complexity: ${event.data.complexity ?? 'LOW'}` +
        `\n│  confirm: ${event.data.needsConfirmation ? 'yes' : 'no'}` +
        (milestones ? `\n│  milestones:${milestones}` : '') +
        steps +
        c('magenta', '\n└─────────────────')
      );
    }

    case 'decomposition': {
      const units = event.data.units
        .map(unit => `\n│  ${unit.order + 1}. [${unit.route}] ${unit.content}`)
        .join('');
      return (
        c('cyan', '\n┌─ DECOMPOSITION') +
        units +
        c('cyan', '\n└─────────────────')
      );
    }

    case 'unit_memory_search': {
      const entryCodes = event.data.result.entries.map(entry => entry.code).join(', ') || '—';
      return (
        c('cyan', '\n┌─ UNIT MEMORY') +
        `\n│  unit:       ${event.data.unit.id} [${event.data.unit.route}]` +
        `\n│  content:    ${event.data.unit.content}` +
        `\n│  strategy:   ${event.data.result.strategy}` +
        `\n│  confidence: ${event.data.result.confidence}` +
        `\n│  entries:    ${entryCodes}` +
        c('cyan', '\n└─────────────────')
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

    case 'milestone_start':
      return (
        c('blue', '\n┌─ MILESTONE START') +
        `\n│  ${event.data.index}/${event.data.total}: ${event.data.title}` +
        `\n│  id: ${event.data.id}` +
        c('blue', '\n└─────────────────')
      );

    case 'milestone_result':
      return (
        c(event.data.success ? 'green' : 'red', '\n┌─ MILESTONE RESULT') +
        `\n│  ${event.data.index}/${event.data.total}: ${event.data.title}` +
        `\n│  id: ${event.data.id}` +
        `\n│  success: ${event.data.success ? 'yes' : 'no'}` +
        c(event.data.success ? 'green' : 'red', '\n└─────────────────')
      );

    case 'milestone_revised':
      return (
        c('yellow', '\n┌─ MILESTONE REVISED') +
        (event.data.fromId ? `\n│  from: ${event.data.fromId}` : '') +
        (event.data.milestoneId ? `\n│  milestone: ${event.data.milestoneId}` : '') +
        (event.data.remaining ? `\n│  remaining: ${event.data.remaining.join(', ') || '—'}` : '') +
        (event.data.revisedCount !== undefined ? `\n│  revised_count: ${event.data.revisedCount}` : '') +
        (event.data.reason ? `\n│  reason: ${event.data.reason}` : '') +
        c('yellow', '\n└─────────────────')
      );

    case 'milestone_memory_cycle':
      return (
        c('green', '\n┌─ MILESTONE MEMORY') +
        `\n│  milestone: ${event.data.milestoneId}` +
        `\n│  writes: ${event.data.writes.join(', ') || '—'}` +
        c('green', '\n└─────────────────')
      );

    case 'token_usage': {
      const fmt = (n: number) => n.toLocaleString();
      return (
        c('dim', `  ◆ TOKENS`) +
        ` in:${fmt(event.data.inputTokens)} out:${fmt(event.data.outputTokens)}` +
        c('dim', ` calls:${event.data.callCount} ~$${event.data.estimatedCostUSD.toFixed(4)}`)
      );
    }

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
