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

- `WINDOW_MANAGER_CLASS=spectre` - The Hyprland class name for window rules (default: "spectre")
- `LM_STUDIO_API_KEY=your-api-key` - Your LM Studio API key for TTS functionality

### 2. Configure Hyprland

Copy the `hyprland.conf` file from the project root to your Hyprland configuration:

```bash
# Method 1: Add to your existing hyprland.conf
cat /path/to/spectre/hyprland.conf >> ~/.config/hypr/hyprland.conf

# Method 2: Copy entire file (replace your config)
cp /path/to/spectre/hyprland.conf ~/.config/hyprland.conf
```

Or add directly to `~/.config/hypr/hyprland.conf`:

```hypr
windowrulev2 = float, class:^(spectre)$
windowrulev2 = noborder, class:^(spectre)$
windowrulev2 = pin, class:^(spectre)$
windowrulev2 = noanim, class:^(spectre)$
```

## Hyprland Rules Explained

| Rule | Effect |
|------|--------|
| `float` | Forces SPECTRE window into floating mode in Hyprland |
| `noborder` | Disables Hyprland borders and global shadows for SPECTRE windows |
| `pin` | Pins the window to all workspaces (persistent across workspace switching) |
| `noanim` | Disables fade animations for smoother appearance/disappearance |

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

## Troubleshooting

### Window not floating

1. Verify `hyprland.conf` is properly configured
2. Check that WINDOW_MANAGER_CLASS matches your environment
3. Restart Hyprland session: `hyprctl dispatch restartworkspace 0`

### Borders/shadows still visible

1. Confirm you're using the latest hyprland.conf with noborder and noanim rules
2. Some Hyprland versions require reloading config after changes
3. Try `killall hyprland && hyprland &` to restart compositor (not recommended in production)

## Security Notes

- Vite dev server is bound to localhost only in development mode
- Production builds do not include network binding configuration
- Always set WINDOW_MANAGER_CLASS environment variable before launching the app
