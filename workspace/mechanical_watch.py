import tkinter as tk
import math
from datetime import datetime

class MechanicalWatchApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Mechanical Watch Simulator")
        self.root.geometry("850x450") # Adjust window size for two canvases + padding
        self.root.resizable(False, False)

        self.CANVAS_SIZE = 400
        self.CENTER_X = self.CANVAS_SIZE / 2
        self.CENTER_Y = self.CANVAS_SIZE / 2
        self.DIAL_RADIUS = self.CANVAS_SIZE / 2 - 20

        self.UPDATE_INTERVAL_MS = 1000 // 30 # ~30 FPS for smooth animation

        # --- Colors ---
        self.DIAL_BG = "#f0f0f0"
        self.DIAL_BORDER = "#333333"
        self.HAND_HOUR_COLOR = "black"
        self.HAND