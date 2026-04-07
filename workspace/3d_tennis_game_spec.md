# 3D Tennis Game Specification

This document outlines the detailed specification and step-by-step implementation plan for developing a Python-based 3D tennis game.

## 1. Project Overview

**Objective:** To create a functional 3D tennis game in Python, featuring core gameplay mechanics, realistic physics simulation for the ball, basic player controls, an AI opponent, and a user-friendly interface.

**Intended Audience:** This document is primarily for developers, project managers, and stakeholders involved in the design and implementation of the 3D tennis game.

**Technology Stack:**
*   **Primary Language:** Python 3.x
*   **3D Game Engine/Framework:** Panda3D (chosen for its Python-native 3D capabilities and comprehensive feature set)
*   **Physics Engine:** Panda3D's built-in collision and physics system.

## 2. Core Game Features

*   **3D Graphics:** Render a tennis court, players, and ball in a 3D environment.
*   **Physics Simulation:** Realistic ball movement including gravity, bounces, and racket interaction.
*   **Player Control:** Keyboard-based movement and racket swing for the human player.
*   **AI Opponent:** Basic artificial intelligence for the computer-controlled player.
*   **Scoring System:** Accurate tennis scoring (0, 15, 30, 40, Deuce, Advantage, Game, Set, Match).
*   **Game States:** Main Menu, Gameplay, Pause Menu, Game Over.
*   **Sound Effects:** Basic audio feedback for game events.

## 3. Non-Functional Requirements

*   **Performance:** The game should run smoothly at a minimum of 30 frames per second (FPS) on a typical modern desktop PC with integrated graphics.
*   **Maintainability:** The codebase should be modular, well-commented, and adhere to Python's PEP 8 style guide to facilitate future updates and debugging.
*   **Scalability (Limited):** The architecture should allow for potential expansion of game modes, additional characters, or court types without major refactoring.
*   **Usability:** The user interface should be intuitive and easy to navigate for players of varying experience levels.
*   **Reliability:** The game should be stable, free from critical crashes, and handle unexpected inputs gracefully.

## 4. Step-by-Step Implementation Plan

### Phase 4.1: Project Setup and Core Structure

**Step 4.1.1: Environment Setup**
*   Install Python 3.x (latest stable version).
*   Install Panda3D: `pip install panda3d`
*   Set up a project directory structure (e.g., `game/`, `assets/models/`, `assets/textures/`, `assets/sounds/`).

**Step 4.1.2: Basic Game Window**
*   Create a main Python script (`main.py`).
*   Initialize a Panda33D `ShowBase` instance to create an empty game window.
*   Implement a basic game loop using `taskMgr.add()`.

**Step 4.1.3: Asset Loading Utility**
*   Create helper functions or a class to manage loading 3D models (`.egg`, `.bam`), textures (`.png`, `.jpg`), and sounds.

### Phase 4.2: Graphics and Scene Setup

**Step 4.2.1: Camera Setup**
*   Configure a fixed camera position and orientation suitable for a tennis game (e.g., behind the player, slightly elevated).
*   Alternatively, implement a simple follow-camera that tracks the ball or player.

**Step 4.2.2: Tennis Court Model**
*   Load a 3D model of a tennis court (placeholder or custom).
*   Position the court at the origin (0,0,0) of the scene.
*   Apply appropriate textures for the court surface, lines, and net.

**Step 4.2.3: Lighting**
*   Implement basic ambient lighting to provide overall scene illumination.
*   Add a directional light source to simulate sunlight and create shadows (optional, but enhances realism).

**Step 4.2.4: Ball Model**
*   Load a simple 3D sphere model for the tennis ball.
*   Apply a tennis ball texture.
*   Position the ball initially at the serve position.

**Step 4.2.5: Player Models**
*   Load placeholder 3D models for the human player and the AI opponent.
*   Position them on their respective sides of the court.
*   Ensure models are scaled correctly relative to the court and ball.

### Phase 4.3: Input and Player Control

**Step 4.3.1: Keyboard Input Handling**
*   Use Panda3D's `base.accept()` to bind keyboard keys to specific game actions (e.g., 'w', 'a', 's', 'd' for movement, 'space' for swing).
*   Implement continuous input checking for movement (e.g., holding down 'w').

**Step 4.3.2: Player Movement**
*   Implement horizontal movement for the human player along their baseline.
*   Restrict player movement to their half of the court.
*   Define a movement speed for the player.

**Step 4.3.3: Racket Swing (Placeholder)**
*   When the swing key is pressed, trigger a temporary visual indicator or a simple animation of the player's racket moving forward.
*   Define a "hitbox" or collision sphere around the racket during the swing.

### Phase 4.4: Physics and Game Mechanics (Ball)

**Step 4.4.1: Ball Physics Initialization**
*   Attach a `CollisionSphere` to the ball model for collision detection.
*   Attach a `PhysicsManager` and `RigidBody` to the ball to enable physics simulation (gravity, velocity, forces).

**Step 4.4.2: Gravity**
*   Apply a constant downward force to the ball's `RigidBody` to simulate gravity.

**Step 4.4.3: Ball Serve Mechanics**
*   When a serve is initiated, apply an initial upward and forward velocity to the ball.
*   Implement a "toss" animation or visual cue before the serve hit.

**Step 4.4.4: Collision Detection**
*   Set up collision handlers for:
    *   Ball vs. Court surface (bounce).
    *   Ball vs. Net.
    *   Ball vs. Out-of-bounds areas (defined by invisible collision planes).
    *   Ball vs. Player Racket (during swing).
    *   Ball vs. AI Racket (during swing).

**Step 4.4.5: Ball Bounce Physics**
*   On collision with the court, calculate reflection vector and reduce ball velocity based on a coefficient of restitution (e.g., 0.7-0.8 for a tennis ball).
*   Implement slight random variation in bounce direction for realism.

**Step 4.4.6: Racket-Ball Interaction**
*   When the ball collides with a swinging racket:
    *   Apply a force to the ball based on the racket's swing direction and power.
    *   Adjust ball spin based on the relative impact point on the racket.
    *   Reset ball's physics state (e.g., clear previous forces, apply new velocity).

### Phase 4.5: Game Logic and Scoring

**Step 4.5.1: Game States Management**
*   Implement a state machine for the game: `MENU`, `PLAYING`, `PAUSED`, `GAME_OVER`.
*   Transition between states based on user input or game events.

**Step 4.5.2: Scoring System**
*   Track scores for Player 1 and Player 2 (AI).
*   Implement tennis scoring rules: 0, 15, 30, 40, Deuce, Advantage, Game.
*   Track games won per set and sets won per match.

**Step 4.5.3: Serve Logic**
*   Alternate serve turns between players after each game.
*   Implement first and second serve attempts.
*   Detect serve faults (ball hits net and doesn't clear, ball lands out of bounds on serve).

**Step 4.5.4: Out-of-Bounds Detection**
*   When the ball lands outside the court boundaries, award a point to the opposing player.

**Step 4.5.5: Net Faults**
*   If the ball hits the net and fails to clear it (during rally or serve), award a point to the opposing player.

**Step 4.5.6: Game/Set/Match Logic**
*   Determine when a player wins a game (first to 40 and 2 points clear).
*   Determine when a player wins a set (first to 6 games and 2 games clear).
*   Determine when a player wins the match (e.g., best of 3 sets).

### Phase 4.6: AI Opponent

**Step 4.6.1: Basic AI Movement**
*   Implement AI logic to track the ball's projected landing position.
*   Move the AI player towards the predicted landing spot on their side of the court.
*   Define AI movement speed.

**Step 4.6.2: AI Racket Swing**
*   When the ball is within a certain range and height of the AI player, trigger an AI swing.
*   Apply force to the ball similar to the human player's swing, with adjustable accuracy and power.

**Step 4.6.3: Difficulty Levels (Optional)**
*   Introduce parameters to adjust AI reaction time, movement speed, and shot accuracy to create different difficulty settings.

### Phase 4.7: User Interface (UI)

**Step 4.7.1: Score Display**
*   Use Panda3D's `DirectLabel` or `TextNode` to display the current game score (e.g., "Player 1: 30 - AI: 15") on the screen during gameplay.

**Step 4.7.2: Main Menu**
*   Create a main menu screen with options: "Start Game", "Options" (placeholder), "Exit".
*   Use Panda3D's `DirectButton` for interactive elements.

**Step 4.7.3: Pause Menu**
*   Implement a pause menu accessible during gameplay (e.g., by pressing 'Esc').
*   Options: "Resume Game", "Restart Game", "Main Menu".

**Step 4.7.4: Game Over Screen**
*   Display the winner of the match.
*   Options: "Play Again", "Main Menu".

### Phase 4.8: Sound and Visual Effects (VFX)

**Step 4.8.1: Sound Loading and Management**
*   Load sound effects (e.g., ball hit, crowd cheer, footsteps, background music).
*   Use Panda3D's `base.loader.loadSfx()` and `AudioSound` objects.

**Step 4.8.2: Ball Hit Sounds**
*   Play a distinct sound effect when the ball is hit by a racket.
*   Play a different sound effect when the ball bounces on the court.

**Step 4.8.3: Basic VFX (Optional)**
*   Implement simple particle effects for ball impact on the ground or racket contact (e.g., small dust cloud).

### Phase 4.9: Refinement and Polish

**Step 4.9.1: Asset Improvement**
*   Replace placeholder models and textures with higher quality, game-ready assets.
*   Optimize asset loading and memory usage.

**Step 4.9.2: Animation**
*   Implement more detailed player animations (running, idle, forehand swing, backhand swing, serve animation).
*   Use Panda3D's animation system (`Actor`).

**Step 4.9.3: Camera Options**
*   Allow players to switch between different camera views (e.g., fixed, follow-ball, first-person from player).

**Step 4.9.4: Bug Fixing, Optimization, and Testing**
*   Thoroughly test the game to identify and fix bugs across all features (physics, AI, UI, scoring).
*   Implement unit tests for critical game logic components (e.g., scoring system, physics calculations).
*   Conduct integration testing to ensure all modules work together seamlessly.
*   Optimize code for performance, especially in physics and rendering loops.
*   Implement error handling and logging for robust operation.

This detailed specification provides a robust framework for developing the 3D tennis game in Python using Panda3D. Each step builds upon the previous, ensuring a structured and manageable development process.