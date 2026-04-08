---
code: PLAN.EX-000073
nb: PLAN
type: EX
name: Regular Subway Runner Game Spec
status: failed
updated: 2026-04-08
summary: Simple Subway Runner with left/right lane controls and obstacle dodging
importance_score: 0
utility_score: 0
usage_count: 0
decay_rate: 0.1
active_page: 1
confidence: 1
last_accessed: 2026-04-07
pinned: 0
source: agent
---

# Regular Subway Runner Game Spec

## Regular Subway Runner Game Specification

### Core Gameplay
- Player character runs automatically forward (infinite runner style)
- Three lanes: left, center, right
- Player can switch between lanes using Left/Right arrow keys or A/D keys

### Obstacles
- Random obstacles appear in lanes that must be dodged
- Types of obstacles: trains, barriers, gaps
- Collision with obstacle = game over

### Scoring System
- Score increases as distance traveled increases
- Speed gradually increases over time for difficulty progression
- High score tracking

### Visual Style
- Simple 2D top-down or side-scrolling view
- Clear lane indicators
- Distinct colors for player, obstacles, background

### Controls
- Left Arrow / A: Move to left lane
- Right Arrow / D: Move to right lane
- Space/Enter: Restart after game over
