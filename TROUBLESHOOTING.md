# Troubleshooting

## Coordinator died during startup

This error means the coordinator tmux session exited before the TUI became
ready. The most common cause is slow shell initialization.

### 1. Measure shell startup time

```bash
time zsh -i -c exit   # for zsh
time bash -i -c exit  # for bash
```

If startup takes more than 1 second, slow shell init is likely the cause.

### 2. Common slow-startup causes

| Cause | Typical delay | Fix |
|-------|---------------|-----|
| oh-my-zsh with many plugins | 1–5s | Reduce plugins, switch to a lighter framework (zinit with lazy loading) |
| nvm (Node Version Manager) | 1–3s | Use `--no-use` + lazy-load nvm, or switch to fnm/volta |
| pyenv init | 0.5–2s | Lazy-load pyenv |
| rbenv init | 0.5–1s | Lazy-load rbenv |
| starship prompt | 0.5–1s | Check `starship timings` |
| conda auto-activate | 1–3s | `auto_activate_base: false` in `.condarc` |
| Homebrew shellenv | 0.5–1s | Cache output instead of evaluating every shell start |

### 3. Configure `shellInitDelayMs`

In `.overstory/config.yaml`:

```yaml
runtime:
  shellInitDelayMs: 3000
```

- Default: `0` (no delay)
- Typical values: `1000`–`5000`
- Values above `30000` (30s) trigger a warning
- Inserts a delay between tmux session creation and TUI readiness polling

### 4. Optimization examples

Lazy-load nvm (add to `~/.zshrc` or `~/.bashrc`):

```bash
# Only activates when you first call nvm/node/npm
export NVM_DIR="$HOME/.nvm"
nvm() { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm "$@"; }
node() { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; node "$@"; }
npm()  { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; npm  "$@"; }
npx()  { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; npx  "$@"; }
```

Reduce oh-my-zsh plugins in `~/.zshrc`:

```bash
# Before: plugins=(git zsh-autosuggestions zsh-syntax-highlighting node npm python ruby rbenv pyenv ...)
# After: keep only what you use regularly
plugins=(git)
```
