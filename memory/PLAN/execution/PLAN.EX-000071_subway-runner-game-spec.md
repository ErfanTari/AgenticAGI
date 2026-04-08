---
code: PLAN.EX-000071
nb: PLAN
type: EX
name: Subway Runner Game Spec
status: failed
updated: 2026-04-08
summary: Simple Subway Runner with left/right lane controls
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

# Subway Runner Game Spec

# Subway Runner Game Specification

## Core Gameplay
- Player character runs automatically forward through an endless subway environment
- Three horizontal lanes (left, center, right) to navigate obstacles
- Player can switch between lanes using LEFT and RIGHT arrow keys or A/D keys
- Avoid trains, barriers, and other obstacles by switching lanes at the right moment
- Score increases over time based on distance traveled
- Game ends when player collides with an obstacle

## Controls
- LEFT ARROW / A: Move to left lane (if not already there)
- RIGHT ARROW / D: Move to right lane (if not already there)
- SPACEBAR: Jump over low obstacles (optional enhancement)

## Graphics Style
- Simple 2D side-scrolling view with top-down perspective
- Player character: Basic colored rectangle or simple sprite
- Obstacles: Red rectangles for trains, blue for barriers
- Environment: Gray tracks, background elements for depth
- Clean, minimalist design without complex textures
- Clear visual distinction between lanes

## Game Mechanics
- Speed gradually increases as score rises
- Random obstacle generation with varying patterns
- Score display in top corner
- Game over screen with final score and restart option
