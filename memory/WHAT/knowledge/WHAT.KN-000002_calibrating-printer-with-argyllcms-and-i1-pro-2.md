---
code: WHAT.KN-000002
nb: WHAT
type: KN
name: Calibrating Printer with ArgyllCMS and i1 Pro 2
status: active
updated: 2026-02-25
summary: Step-by-step guide for color calibration of a printer using ArgyllCMS and X-Rite i1 Pro 2 spectrophotometer.
---

# Calibrating Printer with ArgyllCMS and i1 Pro 2

## Printer Calibration Tutorial: ArgyllCMS + i1 Pro 2

### Prerequisites
- Installed ArgyllCMS (v2.7+)
- Connected X-Rite i1 Pro 2
- Printer with paper loaded
- ICC profile for printer/paper combination

### Step 1: Prepare Your Environment
1. Use consistent lighting (5000K recommended)
2. Ensure printer is warm and stable
3. Load plain, dry media

### Step 2: Create Test Target
```bash
# Generate a multi-size target for measurement
# Recommended: use 24-patch IT8 target
icclamp -p -t it87_3 -o test_target.ti3
```

### Step 3: Print Target
1. Print using printer's highest quality setting
2. Let ink/pigment dry completely (minimum 15 minutes)
3. Flatten sheet to remove curls

### Step 4: Measure Target
```bash
# Use i1 Pro 2 to measure printed target
# Hold sensor firmly against paper surface
# Press button to start measurement
spectro -i -m 60 -o measurements.mea test_target.ti3
```

### Step 5: Analyze and Create Profile
```bash
# Generate ICC profile from measurements
# Use ArgyllCMS's `colprof` tool
# Basic command:
colprof -d "My Printer Profile" -p printer.icc measurements.mea
```

### Step 6: Install and Test Profile
1. Copy `.icc` file to system profiles directory
2. Select in print dialog/printer settings
3. Print test images to verify accuracy

### Troubleshooting
- **Poor matches**: Check lighting, sensor placement, or try different target size
- **Profile errors**: Verify measurements are within tolerance (ΔE < 3)
- **ArgyllCMS crashes**: Update to latest stable version
