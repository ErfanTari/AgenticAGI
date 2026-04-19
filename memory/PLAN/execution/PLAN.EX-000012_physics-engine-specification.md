---
code: PLAN.EX-000012
nb: PLAN
type: EX
name: Physics Engine Specification
status: draft
updated: 2026-04-12
summary: Specification for watch_engine.py
importance_score: 0
utility_score: 0
usage_count: 0
decay_rate: 0.1
active_page: 1
confidence: 1
last_accessed: 2026-04-12
pinned: 0
source: agent
---

# Physics Engine Specification

## Core Physics Engine Specification (watch_engine.py)

**Objective:** To create a foundational physics engine for simulating watch movements and interactions.

**Key Components:**
1.  **Vector/Point Representation:** Basic classes or structures for 2D/3D vectors and points.
2.  **Rigid Body Class:**
    *   Properties: mass, position, velocity, acceleration, rotation (angle/quaternion), angular velocity, angular acceleration, shape (e.g., circle, rectangle, polygon).
    *   Methods: `apply_force(force_vector, point_of_application)`, `update(dt)`.
3.  **Force Generation:** Functions or classes to represent different types of forces (e.g., gravity, spring, drag).
4.  **Collision Detection:** Basic collision detection logic (e.g., AABB, circle-circle, point-in-polygon).
5.  **Collision Resolution:** Simple impulse-based collision response.
6.  **Integrator:** A numerical integration method (e.g., Euler, Verlet) to update positions and velocities over time.
7.  **Engine Class:**
    *   Manages a list of rigid bodies.
    *   `add_body(body)`.
    *   `simulate(dt)`: Iterates through bodies, applies forces, detects and resolves collisions, and updates states using the integrator.

**Initial Scope:** Focus on 2D physics for simplicity, with potential for extension to 3D. Prioritize clear, modular design.
