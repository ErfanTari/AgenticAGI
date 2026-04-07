from direct.showbase.ShowBase import ShowBase
from panda3d.core import AmbientLight, DirectionalLight, VBase4, Vec3, LVector3f, CollisionSphere, CollisionNode, BitMask32
from direct.task import Task
from direct.actor.Actor import Actor # For animated characters, if used later
from direct.interval.IntervalGlobal import Sequence # For simple animations, if used later

class TennisGame(ShowBase):
    def __init__(self):
        ShowBase.__init__(self)

        self.set_window_title("3D Tennis Game")
        self.disableMouse() # Disable default mouse-based camera control

        # --- Game State Variables ---
        self.game_state = "MENU" # Possible states: MENU, PLAYING, PAUSED, GAME_OVER
        self.player_score = 0
        self.ai_score = 0
        self.ball_in_play = False
        self.current_server = "PLAYER" # "PLAYER" or "AI"

        # --- Setup Core Components ---
        self.setup_scene()
        self.setup_ball()
        self.setup_players()
        self.setup_input()
        self.setup_ui()

        # --- Game Loop Task ---
        self.taskMgr.add(self.game_loop_task, "GameLoopTask")
        print("Game initialized. Press 's' to start game (placeholder).")

    def setup_scene(self):
        """
        Sets up the tennis court, camera, and lighting.
        """
        # --- Camera Setup ---
        # Fixed camera position behind the player
        self.camera.setPos(0, -30, 15)
        self.camera.lookAt(0, 0, 0)

        # --- Lighting ---
        # Ambient Light
        ambientLight = AmbientLight("ambientLight")
        ambientLight.setColor(VBase4(0.6, 0.6, 0.6, 1))
        self.ambientLightNodePath = self.render.attachNewNode(ambientLight)
        self.render.setLight(self.ambientLightNodePath)

        # Directional Light (Sunlight)
        directionalLight = DirectionalLight("directionalLight")
        directionalLight.setColor(VBase4(0.8, 0.8, 0.8, 1))
        directionalLight.setDirection(LVector3f(0, 45, -45)) # Angle the light
        self.directionalLightNodePath = self.render.attachNewNode(directionalLight)
        self.render.setLight(self.directionalLightNodePath)

        # --- Tennis Court Model (Placeholder) ---
        # For simplicity, let's use a flat plane for the court
        self.court = self.loader.loadModel("models/plane") # Assuming a plane model exists
        if self.court:
            self.court.reparentTo(self.render)
            self.court.setScale(50, 100, 1) # Scale to resemble a court
            self.court.setPos(0, 0, 0)
            self.court.setTexture(self.loader.loadTexture("textures/court_texture.png"), 1) # Placeholder texture

            # Add collision for the court surface
            court_coll_node = CollisionNode("court_collision")
            court_coll_node.addSolid(CollisionSphere(0, 0, 0, 1)) # A simple sphere for now, will be replaced by mesh collision
            court_coll_node.setFromCollideMask(BitMask32.allOff())
            court_coll_node.setIntoCollideMask(BitMask32.bit(1)) # Bit 1 for ground
            self.court_coll_np = self.court.attachNewNode(court_coll_node)
            self.court_coll_np.show() # For debugging collision shapes

        else:
            print("Warning: 'models/plane' not found. Using a simple cube as court placeholder.")
            self.court = self.loader.loadModel("models/box") # Fallback to a box
            self.court.reparentTo(self.render)
            self.court.setScale(50, 100, 0.1)
            self.court.setPos(0, 0, -0.1)
            self.court.setColor(0.2, 0.6, 0.2, 1) # Green color

        # --- Net Model (Placeholder) ---
        self.net = self.loader.loadModel("models/box") # Simple box for net
        self.net.reparentTo(self.render)
        self.net.setScale(20, 0.5, 5) # Width, Depth, Height
        self.net.setPos(0, 0, 2.5) # Centered on court, half height
        self.net.setColor(0.8, 0.8, 0.8, 1) # Grey color

    def setup_ball(self):
        """
        Loads and initializes the tennis ball model.
        """
        self.ball = self.loader.loadModel("models/sphere") # Assuming a sphere model exists
        if self.ball:
            self.ball.reparentTo(self.render)
            self.ball.setScale(0.5) # Adjust size
            self.ball.setPos(0, -20, 5) # Initial serve position (placeholder)
            self.ball.setTexture(self.loader.loadTexture("textures/tennis_ball.png"), 1) # Placeholder texture
            self.ball_velocity = LVector3f(0, 0, 0) # Initial velocity

            # Add collision for the ball
            ball_coll_node = CollisionNode("ball_collision")
            ball_coll_node.addSolid(CollisionSphere(0, 0, 0, 1)) # Radius 1 for the scaled sphere
            ball_coll_node.setFromCollideMask(BitMask32.bit(0)) # Bit 0 for ball
            ball_coll_node.setIntoCollideMask(BitMask32.bit(1) | BitMask32.bit(2)) # Collides with ground (1) and rackets (2)
            self.ball_coll_np = self.ball.attachNewNode(ball_coll_node)
            self.ball_coll_np.show() # For debugging collision shapes
        else:
            print("Warning: 'models/sphere' not found. Ball will not be visible.")
            self.ball = self.render.attachNewNode("ball_placeholder")
            self.ball.setPos(0, -20, 5)

    def setup_players(self):
        """
        Loads and initializes player and AI models.
        """
        # --- Human Player Model (Placeholder) ---
        self.player = self.loader.loadModel("models/box") # Simple box for player
        self.player.reparentTo(self.render)
        self.player.setScale(1, 1, 3) # Player size
        self.player.setPos(0, -40, 1.5) # Initial position behind baseline
        self.player.setColor(0, 0, 1, 1) # Blue player

        # --- AI Opponent Model (Placeholder) ---
        self.ai_player = self.loader.loadModel("models/box") # Simple box for AI
        self.ai_player.reparentTo(self.render)
        self.ai_player.setScale(1, 1, 3) # AI size
        self.ai_player.setPos(0, 40, 1.5) # Initial position behind baseline
        self.ai_player.setColor(1, 0, 0, 1) # Red AI

        # Player movement state
        self.player_move_left = False
        self.player_move_right = False
        self.player_speed = 15.0

    def setup_input(self):
        """
        Sets up keyboard input handling.
        """
        self.accept("escape", self.exit_game)
        self.accept("s", self.start_game) # Placeholder to start game

        # Player movement
        self.accept("arrow_left", self.set_player_move_left, [True])
        self.accept("arrow_left-up", self.set_player_move_left, [False])
        self.accept("arrow_right", self.set_player_move_right, [True])
        self.accept("arrow_right-up", self.set_player_move_right, [False])

        # Racket swing (placeholder)
        self.accept("space", self.player_swing)

    def setup_ui(self):
        """
        Sets up basic UI elements like score display.
        """
        from direct.gui.OnscreenText import OnscreenText
        self.score_text = OnscreenText(text="Player: 0 - AI: 0", pos=(0.0, 0.9), scale=0.07,
                                       fg=(1, 1, 1, 1), align=TextNode.ACenter,
                                       mayChange=True)
        self.game_message_text = OnscreenText(text="", pos=(0.0, 0.8), scale=0.1,
                                              fg=(1, 1, 0, 1), align=TextNode.ACenter,
                                              mayChange=True)

    def update_score_display(self):
        """Updates the on-screen score display."""
        self.score_text.setText(f"Player: {self.player_score} - AI: {self.ai_score}")

    def display_game_message(self, message, duration=3.0):
        """Displays a temporary message on screen."""
        self.game_message_text.setText(message)
        self.taskMgr.doMethodLater(duration, self.clear_game_message, "ClearGameMessage")

    def clear_game_message(self, task):
        """Clears the game message."""
        self.game_message_text.setText("")
        return Task.done

    def start_game(self):
        """Starts or restarts the game."""
        if self.game_state != "PLAYING":
            self.game_state = "PLAYING"
            self.player_score = 0
            self.ai_score = 0
            self.update_score_display()
            self.reset_ball_for_serve()
            self.display_game_message("Game Started!", 2.0)
            print("Game state changed to PLAYING.")

    def reset_ball_for_serve(self):
        """Resets the ball to the server's position."""
        self.ball_in_play = False
        self.ball_velocity = LVector3f(0, 0, 0)
        if self.current_server == "PLAYER":
            self.ball.setPos(0, -20, 5) # Player's serve position
            self.display_game_message("Player serves!", 2.0)
        else:
            self.ball.setPos(0, 20, 5) # AI's serve position
            self.display_game_message("AI serves!", 2.0)

    def set_player_move_left(self, active):
        self.player_move_left = active

    def set_player_move_right(self, active):
        self.player_move_right = active

    def player_swing(self):
        """Placeholder for player racket swing action."""
        if self.game_state == "PLAYING":
            print("Player swings!")
            # In a real game, this would trigger an animation,
            # activate a racket hitbox, and potentially hit the ball.
            if not self.ball_in_play and self.current_server == "PLAYER":
                # Simple serve logic: launch ball forward and up
                self.ball_velocity = LVector3f(0, 40, 25)
                self.ball_in_play = True
                print("Player served!")

    def game_loop_task(self, task):
        """
        Main game loop. Updates game state, physics, and AI.
        """
        dt = globalClock.getDt() # Delta time for frame-rate independent movement

        if self.game_state == "PLAYING":
            # --- Player Movement ---
            player_x = self.player.getX()
            if self.player_move_left:
                player_x -= self.player_speed * dt
            if self.player_move_right:
                player_x += self.player_speed * dt
            
            # Restrict player to their half of the court (e.g., -20 to 20 on X, -45 to -35 on Y)
            player_x = max(-20, min(20, player_x))
            self.player.setX(player_x)

            # --- Ball Physics (Simplified) ---
            if self.ball_in_play:
                # Apply gravity
                gravity = LVector3f(0, 0, -9.8 * 2) # Exaggerated gravity for faster gameplay
                self.ball_velocity += gravity * dt

                # Update ball position
                self.ball.setPos(self.ball.getPos() + self.ball_velocity * dt)

                # --- Basic Collision Detection (Placeholder) ---
                # This is a very simplistic check. A proper collision system (Panda3D's CollisionHandler)
                # would be used for accurate bounces and interactions.

                # Ball vs. Ground
                if self.ball.getZ() < 0.5: # Assuming court Z is 0, ball radius 0.5
                    self.ball.setZ(0.5) # Place ball on ground
                    self.ball_velocity.setZ(-self.ball_velocity.getZ() * 0.7) # Bounce with energy loss
                    
                    # Check if ball is out of bounds or scores a point
                    ball_pos = self.ball.getPos()
                    if abs(ball_pos.getX()) > 25 or abs(ball_pos.getY()) > 50: # Simple court boundaries
                        print("Ball out of bounds!")
                        if ball_pos.getY() < 0: # Landed on player's side, AI gets point
                            self.ai_score += 1
                            self.display_game_message("Point for AI!", 2.0)
                        else: # Landed on AI's side, Player gets point
                            self.player_score += 1
                            self.display_game_message("Point for Player!", 2.0)
                        self.update_score_display()
                        self.current_server = "AI" if self.current_server == "PLAYER" else "PLAYER" # Alternate serve
                        self.reset_ball_for_serve()
                    else:
                        print("Ball bounced on court.")
                        # Check if it bounced on the wrong side of the net for a serve fault
                        if not self.ball_in_play and self.current_server == "PLAYER" and ball_pos.getY() > 0:
                             print("Serve fault: ball landed on wrong side.")
                             self.ai_score += 1
                             self.display_game_message("Serve Fault! Point for AI!", 2.0)
                             self.update_score_display()
                             self.current_server = "AI"
                             self.reset_ball_for_serve()


                # Ball vs. Net (very basic)
                if abs(self.ball.getY()) < 2 and self.ball.getZ() < self.net.getScale().getZ():
                    if self.ball_velocity.getY() < 0 and self.ball.getY() > 0: # Ball moving towards player
                        self.ball_velocity.setY(-self.ball_velocity.getY() * 0.5) # Reflect with energy loss
                        self.ball_velocity.setZ(self.ball_velocity.getZ() * 0.5) # Lose some vertical speed
                        print("Ball hit net (moving towards player).")
                    elif self.ball_velocity.getY() > 0 and self.ball.getY() < 0: # Ball moving towards AI
                        self.ball_velocity.setY(-self.ball_velocity.getY() * 0.5)
                        self.ball_velocity.setZ(self.ball_velocity.getZ() * 0.5)
                        print("Ball hit net (moving towards AI).")

            # --- AI Movement (Very Basic) ---
            if self.ball_in_play:
                ai_target_x = self.ball.getX()
                ai_current_x = self.ai_player.getX()
                
                # Move AI towards ball's X position
                if ai_target_x > ai_current_x + 1: # Add a small buffer
                    self.ai_player.setX(ai_current_x + self.player_speed * dt * 0.8) # AI slightly slower
                elif ai_target_x < ai_current_x - 1:
                    self.ai_player.setX(ai_current_x - self.player_speed * dt * 0.8)
                
                # Restrict AI to its half of the court
                ai_x = self.ai_player.getX()
                ai_x = max(-20, min(20, ai_x))
                self.ai_player.setX(ai_x)

                # --- AI Swing (Very Basic) ---
                # If ball is near AI and on its side, AI "swings"
                if self.ball.getY() > 30 and abs(self.ball.getX() - self.ai_player.getX()) < 5 and self.ball.getZ() < 10:
                    if self.ball_velocity.getY() > 0: # Only swing if ball is coming towards AI
                        print("AI swings!")
                        # Apply force to ball
                        self.ball_velocity = LVector3f(
                            (self.player.getX() - self.ball.getX()) * 2, # Aim towards player's X
                            -40, # Hit back towards player
                            20 + (self.ball.getZ() - self.ai_player.getZ()) * 5 # Adjust vertical based on ball height
                        )
                        self.ball_in_play = True # Ensure ball is in play after AI hit


        return Task.cont

    def exit_game(self):
        """Exits the Panda3D application."""
        print("Exiting game.")
        self.userExit()

# --- Main execution block ---
if __name__ == "__main__":
    game = TennisGame()
    game.run()