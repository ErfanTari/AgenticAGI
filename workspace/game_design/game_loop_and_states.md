# Game Loop and States for 3D Tennis Game

This document outlines the proposed game states and the core game loop structure for the 3D Tennis Game, based on the overall game design principles and core mechanics.

## 1. Game States

The game will transition between several distinct states to manage different phases of gameplay and user interaction.

### 1.1. Main Menu State
*   **Description:** The initial state where players can start a new game, adjust settings, or view credits.
*   **Transitions:**
    *   To `Game Setup State` (on "Start Game" selection).

### 1.2. Game Setup State (or Loading State)
*   **Description:** Prepares the game environment, loads assets (though minimal due to no textures), and initializes game variables (scores, player positions).
*   **Transitions:**
    *   To `Serving Phase State` (once setup is complete).

### 1.3. Serving Phase State
*   **Description:** Manages the initial serve of a point. The server is determined, and the ball is positioned for the serve. Player input is restricted to serve actions.
*   **Core Mechanics:**
    *   Server player controls ball toss and serve shot (Spacebar for powerful serve).
    *   Opponent player is positioned to receive.
    *   Serve faults (e.g., double fault, net fault) are checked.
*   **Transitions:**
    *   To `Rally Phase State` (on a valid serve).
    *   To `Point Over State` (on a serve fault or ace).

### 1.4. Rally Phase State
*   **Description:** The primary gameplay state where the ball is in play, and players are actively hitting it back and forth.
*   **Core Mechanics:**
    *   **Player Movement:** WASD keys for movement.
    *   **Ball Physics:** Realistic bouncing, trajectory, and interaction with court, net, and players.
    *   **Shot Types:** Space (Upper Hand), U (Middle Hand), I (Backhand).
    *   Collision detection between ball, players, court, and net.
*   **Transitions:**
    *   To `Point Over State` (when the ball goes out of bounds, hits the net twice, or a player fails to return it).

### 1.5. Point Over State
*   **Description:** A brief state after a point concludes, before the score is updated and the next point begins. This state can be used for visual feedback (e.g., "Out!", "Fault!").
*   **Transitions:**
    *   To `Scoring Update State`.

### 1.6. Scoring Update State
*   **Description:** Updates the game score based on the outcome of the previous point. Checks for game, set, and match victories.
*   **Core Mechanics:**
    *   Standard tennis scoring (15, 30, 40, Game).
    *   Determines if a game, set, or match has been won.
*   **Transitions:**
    *   To `Serving Phase State` (if the match is ongoing and a new point needs to be served).
    *   To `Game Over State` (if a player has won the match).

### 1.7. Game Over State
*   **Description:** The match has concluded, and a winner is declared. Displays final scores and offers options to return to the main menu or restart.
*   **Transitions:**
    *   To `Main Menu State`.

## 2. Core Game Loop (within Rally Phase)

The main game loop will continuously execute these steps to update the game state and render visuals, particularly critical during the `Rally Phase State`.

### 2.1. Input Processing
*   **Action:** Read all player inputs (WASD for movement, Space/U/I for shots).
*   **Output:** Update player desired movement vectors and trigger shot actions.

### 2.2. Physics Simulation
*   **Action:**
    *   Update ball position and velocity based on gravity and previous frame's velocity.
    *   Detect collisions:
        *   Ball with court (bounce, angle reflection).
        *   Ball with net (deflection, fault check).
        *   Ball with player (shot interaction, apply force/direction based on shot type).
    *   Update player position based on movement input and collision with court boundaries.
*   **Output:** New positions and velocities for the ball and players.

### 2.3. Game Logic Updates
*   **Action:**
    *   Check for game-ending conditions for the current point:
        *   Ball out of bounds.
        *   Ball hitting the net twice.
        *   Ball bouncing twice on one side.
        *   Player missing the ball.
    *   Update player animations (running, swinging).
    *   Manage game timers or other state-specific logic.
*   **Output:** Triggers state transitions (e.g., to `Point Over State`) or updates internal game variables.

### 2.4. Rendering
*   **Action:** Draw all game elements to the screen based on their updated positions and states.
    *   Render the 3D court, net, and boundaries using solid colors.
    *   Render the ball with its current position.
    *   Render player models with their current positions and animations.
    *   Render any UI elements (score, game state messages).
*   **Output:** A visually updated frame displayed to the player.