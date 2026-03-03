import { initDatabase } from './core/memory/mod.js';
import { processMessage, startAgent, stopAgent } from './core/agent.js';

initDatabase();
startAgent();

(async () => {
  try {
    console.log('\n=== QUICK TEST: Build Landing Page ===\n');

    const result = await processMessage(
      'Build a simple landing page for my AgenticAGI project. It should have a hero section, a features list, and a contact section. Save all files to the workspace, the main file should be called index.html',
      []
    );

    console.log('Intent:', result.intent);
    if (result.intent === 'planned_workflow') {
      console.log('✅ SUCCESS: Planner triggered!');
    } else {
      console.log('❌ FAIL: Planner did not trigger');
      console.log('Created:', result.created?.code);
    }

    console.log('\nReply:\n', result.reply);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    stopAgent();
    process.exit(0);
  }
})();
