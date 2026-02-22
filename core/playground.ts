import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { PATHS } from '../config/agent.config.js';
import { initDatabase, closeDatabase } from './memory/mod.js';
import { processMessage, startAgent, stopAgent } from './agent.js';
import {
  getAutonomyStatus,
  runAutonomyCycle,
  startAutonomyLoop,
  stopAutonomyLoop,
} from './autonomy.js';
import type { Message } from './types.js';

function formatAutonomyStatus(): string {
  const status = getAutonomyStatus();
  return [
    `autonomy.enabledByConfig=${status.enabledByConfig}`,
    `autonomy.loopActive=${status.loopActive}`,
    `autonomy.cycleRunning=${status.cycleRunning}`,
    `autonomy.intervalMs=${status.intervalMs}`,
    `autonomy.maxTasksPerCycle=${status.maxTasksPerCycle}`,
  ].join('\n');
}

async function handleCommand(userInput: string): Promise<string | null> {
  if (!userInput.startsWith('/')) return null;
  const parts = userInput.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  if (command === '/help') {
    return [
      'Commands:',
      '- /help',
      '- /autonomy status',
      '- /autonomy run [maxTasks]',
      '- /autonomy on',
      '- /autonomy off',
      '- /exit or /quit',
    ].join('\n');
  }

  if (command !== '/autonomy') {
    return 'Unknown command. Use /help.';
  }

  const sub = (parts[1] ?? 'status').toLowerCase();
  if (sub === 'status') {
    return formatAutonomyStatus();
  }

  if (sub === 'on') {
    const started = startAutonomyLoop({ force: true });
    return started
      ? `Autonomy loop is running.\n${formatAutonomyStatus()}`
      : 'Autonomy loop did not start.';
  }

  if (sub === 'off') {
    stopAutonomyLoop();
    return `Autonomy loop stopped.\n${formatAutonomyStatus()}`;
  }

  if (sub === 'run') {
    const parsed = Number(parts[2] ?? '');
    const maxTasks = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
    const result = await runAutonomyCycle(maxTasks ? { maxTasks } : undefined);
    return [
      `Autonomy cycle completed at ${result.ranAt}`,
      `- scanned: ${result.scanned}`,
      `- processed: ${result.processed}`,
      `- completed: ${result.completed}`,
      `- failed: ${result.failed}`,
      `- reports: ${result.reports.length}`,
    ].join('\n');
  }

  return 'Unknown /autonomy command. Use /autonomy status|run|on|off.';
}

async function main(): Promise<void> {
  initDatabase(PATHS.db);
  startAgent();
  startAutonomyLoop();

  const history: Message[] = [];
  const rl = readline.createInterface({ input, output });

  console.log('Agent ready. Type your message. Use /exit to quit.');

  while (true) {
    let rawInput = '';
    try {
      rawInput = await rl.question('you> ');
    } catch (error) {
      // Handles non-interactive/piped stdin where readline can close unexpectedly.
      const code = (error as { code?: string })?.code;
      if (code === 'ERR_USE_AFTER_CLOSE') break;
      throw error;
    }

    const userInput = rawInput.trim();
    if (!userInput) continue;

    if (userInput === '/exit' || userInput === '/quit') {
      break;
    }

    const commandReply = await handleCommand(userInput);
    if (commandReply !== null) {
      console.log(`agent> ${commandReply}\n`);
      continue;
    }

    try {
      const response = await processMessage(userInput, history);
      console.log(`agent> ${response.reply}\n`);

      history.push({ role: 'user', content: userInput });
      history.push({ role: 'assistant', content: response.reply });
      if (history.length > 12) history.splice(0, history.length - 12);
    } catch (error) {
      console.log(`agent> Error: ${String(error)}\n`);
    }
  }

  rl.close();
  stopAutonomyLoop();
  stopAgent();
  closeDatabase();
}

main().catch(error => {
  console.error('Fatal error:', error);
  stopAutonomyLoop();
  stopAgent();
  closeDatabase();
  process.exitCode = 1;
});
