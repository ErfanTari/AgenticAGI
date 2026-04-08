---
code: PLAN.EX-000077
nb: PLAN
type: EX
name: zaraban-portfolio-spec
status: active
updated: 2026-04-08
summary: Spec for Zaraban Portfolio Website with colorful placeholder cards
importance_score: 0
utility_score: 0
usage_count: 0
decay_rate: 0.1
active_page: 1
confidence: 1
last_accessed: 2026-04-08
pinned: 0
source: agent
---

# zaraban-portfolio-spec

## Zaraban Portfolio Website Specification

**Goal**: Create a modern, responsive portfolio website for 'Zaraban' with a dark theme.

**Libraries**: 
- Google Fonts: Poppins (headings), Roboto (body) via Google Fonts CDN.
- No external JS frameworks needed; vanilla JS for mobile menu.

**Visual Layout**:
- **Theme**: Dark background (#1a1a1a), light text (#f0f0f0).
- **Header**: Fixed top bar with 'Zaraban' logo (left) and navigation links (right). Responsive hamburger menu for mobile.
- **Hero Section**: Large centered text: 'Hi, I'm Zaraban', subtitle 'Creative Developer & Designer', and a 'View My Work' CTA button.
- **About Section**: Two-column layout on desktop (text left, placeholder avatar right). Text: 'Passionate about building digital experiences...'
- **Skills Section**: Grid of skill cards with icons (using emoji or simple CSS shapes) and labels (e.g., HTML, CSS, JavaScript, Design).
- **Portfolio Gallery**: 8-item grid. Each item is a solid-color card with a title and description overlay. Colors: #FF6B6B (Red), #4ECDC4 (Teal), #45B7D1 (Blue), #96CEB4 (Green), #FFEEAD (Yellow), #D4A5A5 (Pink), #6C5B7B (Purple), #355C7D (Navy). Cards have hover effects (scale up, shadow).
- **Footer**: Simple footer with copyright and social links.

**Interaction Model**:
- Smooth scrolling for anchor links.
- Mobile hamburger menu toggles navigation visibility.
- Portfolio cards scale up and show a subtle shadow on hover.
- CTA button has a pulse animation on hover.

**Algorithms/Features**:
- CSS Grid for gallery layout (responsive: 1 col mobile, 2 col tablet, 4 col desktop).
- Flexbox for header and hero alignment.
- CSS transitions for hover effects.
- Vanilla JS for mobile menu toggle.

**Color Palette**:
- Background: #1a1a1a
- Text: #f0f0f0
- Accent: #4ECDC4
- Card Colors: #FF6B6B, #4ECDC4, #45B7D1, #96CEB4, #FFEEAD, #D4A5A5, #6C5B7B, #355C7D

**File Structure**: Single self-contained HTML file with inline CSS and JS.
