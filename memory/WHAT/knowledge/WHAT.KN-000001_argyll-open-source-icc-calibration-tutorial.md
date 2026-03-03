---
code: WHAT.KN-000001
nb: WHAT
type: KN
name: Argyll Open Source ICC Calibration Tutorial
status: active
updated: 2026-02-25
summary: Tutorial on using Argyll for ICC color calibration
---

# Argyll Open Source ICC Calibration Tutorial

## Overview of Argyll

Argyll is open-source software for creating ICC profiles for displays, printers, and scanners.

### Installation
- Linux: `sudo apt-get install argyllcms`
- macOS: Use Homebrew: `brew install argyllcms`
- Windows: Download from official website

### Basic Workflow
1. Measure display using a colorimeter (e.g., Datacolor Spyder)
2. Generate measurement data with `dispcal`
3. Create ICC profile with `iccstore`
4. Install profile in system
