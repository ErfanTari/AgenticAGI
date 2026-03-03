import { processMessage } from './core/agent.js';

const prompt = `I need a professional portfolio website for myself.

Design requirements:
- Dark theme, minimal, modern
- Smooth scroll navigation
- Hero section with my name and title
- About section with a short bio
- Projects section showing my work
- Skills section
- Contact section with email
- Mobile responsive
- Subtle CSS animations on scroll

Technical requirements:
- Single HTML file with embedded CSS and JS
- No external dependencies or CDN links
- Everything self-contained
- Page load under 50KB total
- Valid HTML5 semantic structure

Content:
Use everything you know about me from memory.
My projects, my skills, my background.
Do not use placeholder text anywhere.
Every word should be real content about me.

Process:
1. First read my memory to gather all content
2. Plan the full structure before writing
3. Write the complete HTML file
4. Verify the file size is under 50KB
5. Check that all sections exist
6. If anything is missing or wrong, fix it
7. Save final version as workspace/portfolio.html
8. Give me a summary of what you built and what content you pulled from memory`;

console.log('=== PORTFOLIO WEBSITE TEST ===\n');
const result = await processMessage(prompt, []);
console.log('\n✓ Test completed');
console.log('Intent:', result.intent);
console.log('\n' + '='.repeat(80));
console.log('AGENT REPLY:');
console.log('='.repeat(80));
console.log(result.reply);
