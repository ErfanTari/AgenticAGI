---
code: PLAN.EX-000008
nb: PLAN
type: EX
name: mechanical-watch-app-spec
status: failed
updated: 2026-04-12
summary: Specification for a Python mechanical watch simulation app
importance_score: 0
utility_score: 0
usage_count: 0
decay_rate: 0.1
active_page: 1
confidence: 1
last_accessed: 2026-04-11
pinned: 0
source: agent
---

# mechanical-watch-app-spec

## Python Mechanical Watch Simulation App

**Objective:** Create a Python application that simulates the mechanical operation of a watch gear train, demonstrating actual gear interaction and rotation, not just a cosmetic display.

**Core Components:**
1.  **Gear Representation:**
    *   Each gear object will have properties: `teeth_count`, `radius`, `position (x, y)`, `angle_rad` (current rotation in radians).
    *   Gears will be connected in a 'train', where the rotation of one drives the next.
2.  **Gear Train Logic:**
    *   Implement the physics of gear meshing: when one gear rotates, the connected gear rotates in the opposite direction, with a speed ratio determined by their teeth counts.
    *   `rotation_ratio = driving_gear.teeth_count / driven_gear.teeth_count`
    *   `driven_gear.angle_change = driving_gear.angle_change * rotation_ratio`
3.  **Mainspring/Power Source:**
    *   Simulate a continuous input rotation (e.g., a constant angular velocity) to the first gear in the train, representing the mainspring's power.
4.  **Escapement Mechanism (Simplified):**
    *   A simplified escapement will be implemented to regulate the final gear's rotation, mimicking the tick-tock motion and ensuring a consistent, timed advance.
    *   This could involve advancing the escapement wheel by a fixed increment at regular intervals.
5.  **Graphical User Interface (GUI):**
    *   Use a Python GUI library (e.g., `Tkinter` or `PyQt5`) to visualize the gears.
    *   Each gear will be drawn as a circle with lines representing teeth or spokes to clearly show rotation.
    *   Gears will be positioned relative to each other to show meshing.
    *   The GUI will update periodically to show the gears rotating in real-time.

**Technical Details:**
*   **Language:** Python 3.x
*   **GUI Library:** `Tkinter` for simplicity and standard library inclusion.
*   **Simulation Loop:** A main loop will update gear positions and redraw the canvas at a set frame rate.
*   **Gear Drawing:** Use `canvas.create_oval` for the main gear body and `canvas.create_line` for teeth/spokes.

**Initial Gear Train (Example):**
*   **Mainspring Barrel Gear:** 80 teeth (driving)
*   **Center Wheel Pinion:** 10 teeth (driven by barrel gear)
*   **Center Wheel:** 60 teeth (drives third wheel pinion)
*   **Third Wheel Pinion:** 8 teeth (driven by center wheel)
*   **Third Wheel:** 50 teeth (drives fourth wheel pinion)
*   **Fourth Wheel Pinion:** 7 teeth (driven by third wheel)
*   **Fourth Wheel (Seconds Wheel):** 40 teeth (drives escapement pinion)
*   **Escapement Pinion:** 6 teeth (driven by fourth wheel)
*   **Escapement Wheel:** 15 teeth (regulated by escapement)

**Interaction:**
*   The simulation will run automatically upon launch.
*   No user interaction is required beyond starting and closing the application.

**Visuals:**
*   Gears will be drawn with different colors or outlines to distinguish them.
*   The canvas will have a neutral background color.
*   Rotation will be visually represented by the movement of lines/spokes on the gears.
