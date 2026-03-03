import { initDatabase } from './core/memory/mod.js';
import { processMessage, startAgent, stopAgent } from './core/agent.js';
import type { Message } from './core/types.js';

// Initialize
initDatabase();
startAgent();

const history: Message[] = [];

async function runTest(testName: string, prompt: string) {
  console.log('\n' + '='.repeat(80));
  console.log(`TEST: ${testName}`);
  console.log('='.repeat(80));
  console.log(`Prompt: ${prompt}\n`);

  try {
    const start = Date.now();
    const result = await processMessage(prompt, history);
    const elapsed = Date.now() - start;

    // Update history
    history.push({ role: 'user', content: prompt });
    history.push({ role: 'assistant', content: result.reply });
    if (history.length > 12) history.splice(0, 2);

    // Report
    console.log(`\n✓ Completed in ${elapsed}ms`);
    console.log(`Intent: ${result.intent}`);
    if (result.created) console.log(`Created: ${result.created.code}`);
    if (result.retries) console.log(`Retries: ${result.retries}`);
    console.log('\nAgent reply:');
    console.log(result.reply);
    console.log('\n' + '-'.repeat(80));

    return result;
  } catch (err) {
    console.error(`\n✗ Test failed: ${err}`);
    throw err;
  }
}

// Run tests sequentially
(async () => {
  try {
    // Test 1: Build landing page
    await runTest(
      'Test 1: Build Landing Page',
      'Build a simple landing page for my AgenticAGI project. It should have a hero section, a features list, and a contact section. Save all files to the workspace, the main file should be called index.html'
    );

    // Test 2: Search and download image
    await runTest(
      'Test 2: Search & Download Image',
      'Search the web for a free placeholder image URL for a tech website hero section, download it to the workspace as hero.jpg, then update the index.html to reference it'
    );

    // Test 3: Create React starter
    await runTest(
      'Test 3: Create React Starter Structure',
      'Create a basic React TypeScript starter project structure with folders for src, public, and components. Create README.md, package.json, and a basic App.tsx component file'
    );

    // Test 4: Full autonomous pipeline
    await runTest(
      'Test 4: Portfolio from Memory',
      'Build a single page portfolio website for me. You know I\'m Erfan Tari, digital design specialist, working on AgenticAGI and Meeting Local. Use that information. Create all files, organize them properly, and verify everything works by checking the HTML is valid'
    );

    // Test 5: REST API stress loop
    await runTest(
      'Test 5: Node.js REST API with Testing',
      'I want to build a simple Node.js REST API with one endpoint GET /health that returns {"status": "ok"}. Build it, run it in background, test the endpoint, kill the server, fix any issues found, and save a HOW entry documenting the process'
    );

    console.log('\n' + '='.repeat(80));
    console.log('ALL TESTS COMPLETED');
    console.log('='.repeat(80));
  } catch (err) {
    console.error('Test suite failed:', err);
  } finally {
    stopAgent();
    process.exit(0);
  }
})();
