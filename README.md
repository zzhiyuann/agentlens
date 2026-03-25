# AgentLens

**Chrome DevTools for AI agents.** Record, replay, inspect, and test agent sessions from your terminal.

> Stop debugging AI agents with `print()` statements and raw JSON. See exactly what your agent thinks, decides, and does — step by step.

<p align="center">
  <img src="docs/demo.gif" alt="AgentLens demo" width="700">
</p>

## Features

### Session Debugger
Record agent sessions transparently and replay them interactively.

- **Record** — Capture every LLM call, tool invocation, and response
- **Replay** — Step forward/backward through agent decisions
- **Inspect** — See full prompts, responses, tokens, and costs per step
- **Diff** — Compare two session runs side by side
- **Export** — JSON, HTML, or Markdown

### Memory Inspector
Visualize, diff, and analyze agent memory across sessions.

- **Show** — View memory state with freshness indicators
- **Diff** — See what changed between git commits or dates
- **Timeline** — Memory evolution over time
- **Health** — Detect stale, orphaned, and duplicate entries

### Multi-Agent Test Harness
Pytest for AI agents. Define scenarios in YAML, assert on behavior.

- **YAML scenarios** — Define agent workflows declaratively
- **Tool mocking** — Mock specific tools to isolate behavior
- **Assertions** — Assert on tool calls, outputs, memory, and cost
- **Regression detection** — Catch behavior changes across code versions
- **CI-friendly** — Exit code 0/1, structured output

## Quickstart

```bash
# Install
npm install -g agentlens

# Record your first session
alens record claude "Fix the bug in auth.ts"

# List recordings
alens list

# Replay interactively
alens replay ses_a1b2c3d4

# Inspect memory
alens memory show ~/.claude/projects/myproject/memory/

# Run tests
alens test run tests/customer-support.yaml
```

## Session Recording

```bash
# Record a Claude Code session
alens record claude "Refactor auth to JWT"

# Record with a label
alens record --label "refactor-v2" claude "Refactor auth"

# Record any command
alens record python my_agent.py
```

Recording is transparent — your agent runs normally. AgentLens captures traces via hooks, not output parsing.

```
✔ Session recorded: ses_a1b2c3d4
  Duration: 4m 32s
  LLM calls: 12  |  Tool calls: 28
  Tokens: 45,230  |  Cost: $0.47
```

## Session Replay

```bash
alens replay ses_a1b2c3d4
```

Interactive step-through with keyboard controls:

| Key | Action |
|-----|--------|
| `n` / `→` | Next step |
| `p` / `←` | Previous step |
| `j <num>` | Jump to step |
| `e` | Expand full prompt/response |
| `c` | Toggle cost overlay |
| `f` | Search in session |
| `q` | Quit |

## Memory Inspector

```bash
# View memory state
alens memory show ./memory/

# Diff between git commits
alens memory diff ./memory/ --from HEAD~5

# Memory evolution timeline
alens memory timeline ./memory/

# Health check with recommendations
alens memory health ./memory/
```

Health scoring detects:
- **Stale** entries (not updated in 2+ weeks)
- **Orphaned** entries (not in index)
- **Duplicates** (overlapping content)
- **Size issues** (files too large to be useful)

## Test Harness

Define test scenarios in YAML:

```yaml
# tests/customer-support.yaml
name: "Customer refund flow"
agents:
  - role: support-agent
    model: claude-sonnet-4-6

scenario:
  - user: "I want a refund for order #12345"
  - assert:
      tool_called: lookup_order
      tool_args: { order_id: "12345" }
  - mock_tool_response:
      lookup_order: { status: "delivered", amount: 49.99 }
  - assert:
      response_contains: "refund"
      cost_under: 0.05
```

Run tests:

```bash
# Single scenario
alens test run tests/customer-support.yaml

# All scenarios in a directory
alens test run tests/ --parallel

# Validate without running
alens test validate tests/customer-support.yaml
```

## Adapters

AgentLens uses an adapter architecture to support different agent frameworks.

| Adapter | Status | Install |
|---------|--------|---------|
| Claude Code | Shipped | Built-in |
| OpenAI Agents SDK | Planned | Community |
| CrewAI | Planned | Community |
| LangGraph | Planned | Community |
| Custom | Available | [Docs](docs/adapters.md) |

### Writing a Custom Adapter

```typescript
import { AgentAdapter } from 'agentlens';

export class MyAdapter implements AgentAdapter {
  name = 'my-framework';
  version = '1.0.0';

  async detect(): Promise<boolean> {
    // Return true if this adapter can handle the current environment
  }

  async startRecording(options: RecordOptions): Promise<RecordingHandle> {
    // Hook into your framework's execution
  }

  async stopRecording(handle: RecordingHandle): Promise<Session> {
    // Return the captured session
  }
}
```

## Configuration

```yaml
# ~/.agentlens/config.yaml

adapter: claude-code

storage:
  path: ~/.agentlens/traces.db
  maxSize: 500mb

display:
  theme: dark
  colors: true

recording:
  autoLabel: true
  maxDuration: 30m

memory:
  staleDays: 14
```

## Commands

| Command | Description |
|---------|-------------|
| `alens record [cmd]` | Record an agent session |
| `alens list` | List recorded sessions |
| `alens inspect <id>` | Detailed session view |
| `alens replay <id>` | Interactive step-through replay |
| `alens diff <a> <b>` | Compare two sessions |
| `alens export <id>` | Export session (JSON/HTML/MD) |
| `alens memory show <path>` | View memory state |
| `alens memory diff <path>` | Memory changes over time |
| `alens memory timeline <path>` | Memory evolution |
| `alens memory health <path>` | Memory quality report |
| `alens test run <file>` | Run test scenarios |
| `alens test validate <file>` | Validate scenario files |
| `alens test list` | List available scenarios |
| `alens stats` | Aggregate statistics |
| `alens config` | View/update configuration |
| `alens init` | Initialize in a project |

## Pricing

| Tier | Features | Price |
|------|----------|-------|
| **Community** | Full CLI, all 3 modules, Claude Code adapter, local storage, MIT license | **Free forever** |
| **Pro** | Cloud storage, web dashboard, team sharing, all adapters, 90-day retention | $49/mo |
| **Team** | SSO, audit logs, CI/CD integration, unlimited retention, priority support | $99/seat/mo |

## Philosophy

1. **Zero-config start** — `npm install && alens record` should work immediately
2. **CLI-first** — Developers live in terminals, not dashboards
3. **Privacy-safe** — All data local by default, cloud is opt-in
4. **Framework-agnostic** — Adapters, not lock-in
5. **Familiar patterns** — pytest for tests, DevTools for replay, git diff for memory

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Priority areas:
- Framework adapters (OpenAI, CrewAI, LangGraph)
- Test assertion types
- Memory format support
- Documentation and examples

## License

MIT. See [LICENSE](LICENSE).

---

Built by [RyanHub](https://ryanwang.dev) — the company run by 6 AI agents.
