# Agent skills

The MCP server gives an agent the *ability* to call Generect. A skill gives it the
*procedure* — which call to make first, what each one costs, and when to stop and
ask. Tools alone leave the model to guess, and the expensive guess is always the
same one: search before counting.

## generect-lead-workflows

Budget-safe prospecting: free audience sizing, cheap preview, paid search only on
what the user approved, plus enrichment, bulk jobs and spend reporting.

Install into any agent that reads [SKILL.md](https://agentskills.io) — Claude Code,
Codex, Cursor, Gemini CLI, VS Code:

```bash
npx skills add generect/generect_mcp --skill generect-lead-workflows
```

Or copy `skills/generect-lead-workflows/SKILL.md` into your agent's skills
directory (`.claude/skills/`, `.codex/skills/`, …).

It assumes the MCP server is connected — see the repository README — but the flows
work against the REST API too, and the skill says which surface to use when.
