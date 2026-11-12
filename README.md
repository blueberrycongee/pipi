# pipi

A native desktop control surface for coding agents, built with
[Native Shell (nsh)](https://nsh.dev) — TSX UI on top of platform-native
views.

pipi drives the agent CLIs already on your machine — Pi, Claude Code,
Codex, Devin, Cursor, OpenCode, Gemini CLI, GitHub Copilot, Grok, Goose,
Kimi, Qwen Code, DeepSeek Harness, Antigravity, Hermes, Kiro, Factory
Droid, Amp, or any custom ACP harness — over their own protocols, with
your own sign-ins and subscriptions. If it's set up on your computer,
pipi can drive it.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # one agent CLI; any supported one works
nsh dev .                                                        # run with hot reload
```

No API key yet? `node dev/mock-llm.mjs` plus
`PI_CODING_AGENT_DIR=$PWD/dev/agent nsh dev .` runs the real agent against a
scripted model. Otherwise add a key in Settings → Providers.

See [DESIGN.md](DESIGN.md) for the design system and Pip, the mascot, and
[AGENTS.md](AGENTS.md) for the architecture and contributor notes.
