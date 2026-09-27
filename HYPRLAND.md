# Hyprland Integration Documentation

## Overview

SPECTRE integrates with Hyprland window manager to provide floating windows that ignore Hyprland's default decorations and shadows, and are pinned to all workspaces.

## Installation

### 1. Set Environment Variables

Create a `.env` file in the project root:

```bash
# Create .env from template (optional)
cp .env.example .env

# Edit .env with your values
nano .env
```

Required environment variables:

- `WINDOW_MANAGER_CLASS=spectre` - The Hyprland class name pattern for window rules (default: "spectre")
  - Uses Hyprland's `windowrulev2` regex pattern `class:^(spectre)$` to match the window class
  - Can be customized if using a different WM integration strategy
- `LM_STUDIO_API_KEY=your-api-key` - Your LM Studio API key for TTS functionality

### 2. Configure Hyprland

Copy the `hyprland.conf` file from the project root to your Hyprland configuration:

```bash
# Method 1: Append to your existing hyprland.conf
cat /path/to/spectre/hyprland.conf >> ~/.config/hypr/hyprland.conf

# Method 2: Copy entire file (replace your config)
cp /path/to/spectre/hyprland.conf ~/.config/hyprland.conf
```

Or add directly to `~/.config/hypr/hyprland.conf`:

```hypr
# SPECTRE Window Rules - using windowrulev2 with class pattern matching
windowrulev2 = float, class:^(spectre)$              # Floating window mode (no stacking group)
windowrulev2 = noborder, class:^(spectre)$          # Disable Hyprland borders and shadows
windowrulev2 = pin, class:^(spectre)$               # Pin to all workspaces (persistent)
windowrulev2 = noanim, class:^(spectre)$            # Disable fade animations
windowrulev2 = transparent 0.95, class:^(spectre)$  # Set window opacity to 95%
```

## Hyprland Rules Explained

The hyprland.conf file uses **Hyprland's `windowrulev2` syntax** with regex pattern matching on the window class:

```hypr
# Pattern: class:^(spectre)$ matches window class exactly "spectre"
windowrulev2 = float, class:^(spectre)$  # Floating window mode (no stacking group)
windowrulev2 = noborder, class:^(spectre)$  # Disable Hyprland borders and shadows
windowrulev2 = pin, class:^(spectre)$       # Pin to all workspaces (persistent)
windowrulev2 = noanim, class:^(spectre)$    # Disable fade animations
```

| Rule | Effect |
|------|--------|
| `float` | Forces SPECTRE window into floating mode in Hyprland (excludes from stacking group) |
| `noborder` | Disables Hyprland borders and global shadows for SPECTRE windows |
| `pin` | Pins the window to all workspaces (persistent across workspace switching) |
| `noanim` | Disables fade animations for smoother appearance/disappearance |
| `transparent <value>` | Sets window opacity; value is decimal between 0.0 and 1.0 (e.g., 0.95 = 95% opaque) |

## Development Workflow

### Starting the Application

```bash
npm run dev
```

The app will:
1. Start a Vite dev server on port 5173 (localhost only in development)
2. Create an Electron BrowserWindow with Hyprland integration settings
3. Apply floating, borderless, shadowless, and workspace-pinned behavior via Hyprland rules

### Validation Script

Run the built-in validation script to verify setup:

```bash
node scripts/validate-hyprland.ts
```

Expected output:
```
[✓] hyprland.conf exists
[✓] Found: Floating window mode
[✓] Found: Disable Hyprland borders
[✓] Found: Workspace pinning (fixed on all workspaces)
[✓] Found: Disable window animations
[✓] All Hyprland integration rules validated successfully
[✓] WINDOW_MANAGER_CLASS is configured
[✓] LM_STUDIO_API_KEY is configured
```

## Acceptance Criteria

✅ SPECTRE always floats in Hyprland (no stacking group)
✅ Ignored Hyprland borders and global shadows
✅ Pinned to all workspaces (persistent across workspace switching)
✅ Window opacity set via transparency rule (default 95%)

## Troubleshooting

### Window not floating

1. Verify `hyprland.conf` is properly configured with all five rules (float, noborder, pin, noanim, transparent)
2. Check that the WINDOW_MANAGER_CLASS matches your environment's window class pattern
3. Restart Hyprland session: `hyprctl dispatch restartworkspace 0`
4. Ensure the window rule order is correct in hyprland.conf

### Transparency not applied

1. Confirm the transparency rule syntax is correct: `windowrulev2 = transparent <value>, class:^(spectre)$`
2. The `<value>` must be a decimal between 0.0 (fully transparent) and 1.0 (fully opaque)
3. Restart Hyprland session or reload config if transparency doesn't apply

### Pattern matching issues

The class pattern uses **regex syntax** where:
- `^` matches start of string
- `$` matches end of string
- `^(spectre)$` matches exactly "spectre" (no prefix/suffix)

If using a custom class name, update the rules in hyprland.conf and .env accordingly.

## Security Notes

- Vite dev server is bound to localhost only in development mode
- Production builds do not include network binding configuration
- Always set WINDOW_MANAGER_CLASS environment variable before launching the app
- The hyprland.conf rules use regex pattern matching; ensure class name matches your application window
- Transparency rule `transparent 0.95` sets 95% opacity (adjustable between 0.0–1.0)
