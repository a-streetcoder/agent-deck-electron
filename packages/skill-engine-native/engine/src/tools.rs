//! Tool registry + detector: which coding agents are installed and where their
//! global skills directories live. Data-driven so coverage grows without code churn.

use std::path::{Path, PathBuf};

/// A coding agent / AI tool Syncr can fan skills out to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tool {
    pub id: &'static str,
    pub name: &'static str,
    /// Config directory under the scope root ($HOME, or a project root); its existence marks
    /// the tool as present in that scope.
    pub config_dir: &'static str,
    /// Subdirectory under `config_dir` holding skills (usually "skills").
    pub skills_subdir: &'static str,
    pub cli: &'static str,
}

/// A tool detected as present on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedTool {
    pub id: &'static str,
    pub name: &'static str,
    pub skills_dir: PathBuf,
}

/// The built-in registry of supported tools. `.agents` is the vendor-neutral
/// canonical dir (read by Codex/Cursor/OpenCode); the rest are per-tool dirs.
///
/// The long tail is mined from vercel-labs/skills `src/agents.ts` — the SOURCE registry their CLI
/// ships, not its README. Deliberately absent: tools whose global skills dir IS `~/.agents/skills`
/// (Warp, Zed, Dexto, Loaf, Kimi, current Cline) — that is the canonical catalog itself, so a
/// fan-out link would be self-referential; and project-only tools (Eve, PromptScript), because
/// fan-out is home-scoped. Env-var home overrides (CODEX_HOME, CLAUDE_CONFIG_DIR, …) are not
/// honoured — the registry is static data; a host that needs them resolves before calling in.
/// Detection stays presence-keyed (`config_dir` exists), so a 60-entry registry links only the
/// handful of tools actually installed.
pub fn registry() -> &'static [Tool] {
    const TOOLS: &[Tool] = &[
        Tool {
            id: "agents",
            name: "Agents (canonical)",
            config_dir: ".agents",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "claude-code",
            name: "Claude Code",
            config_dir: ".claude",
            skills_subdir: "skills",
            cli: "claude",
        },
        Tool {
            id: "codex",
            name: "Codex",
            config_dir: ".codex",
            skills_subdir: "skills",
            cli: "codex",
        },
        Tool {
            id: "cursor",
            name: "Cursor",
            config_dir: ".cursor",
            skills_subdir: "skills",
            cli: "cursor",
        },
        Tool {
            id: "opencode",
            name: "OpenCode",
            config_dir: ".config/opencode",
            skills_subdir: "skills",
            cli: "opencode",
        },
        Tool {
            id: "gemini",
            name: "Gemini CLI",
            config_dir: ".gemini",
            skills_subdir: "skills",
            cli: "gemini",
        },
        Tool {
            id: "windsurf",
            name: "Windsurf",
            config_dir: ".codeium/windsurf",
            skills_subdir: "skills",
            cli: "windsurf",
        },
        Tool {
            id: "kilo",
            name: "Kilo Code",
            config_dir: ".kilocode",
            skills_subdir: "skills",
            cli: "kilo",
        },
        Tool {
            id: "cline",
            name: "Cline",
            config_dir: ".cline",
            skills_subdir: "skills",
            cli: "cline",
        },
        Tool {
            id: "roo",
            name: "Roo Code",
            config_dir: ".roo",
            skills_subdir: "skills",
            cli: "roo",
        },
        Tool {
            id: "copilot",
            name: "GitHub Copilot",
            config_dir: ".copilot",
            skills_subdir: "skills",
            cli: "copilot",
        },
        Tool {
            id: "qwen",
            name: "Qwen Code",
            config_dir: ".qwen",
            skills_subdir: "skills",
            cli: "qwen",
        },
        Tool {
            id: "adal",
            name: "AdaL",
            config_dir: ".adal",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "aider-desk",
            name: "AiderDesk",
            config_dir: ".aider-desk",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "antigravity",
            name: "Antigravity",
            config_dir: ".gemini/antigravity",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "antigravity-cli",
            name: "Antigravity CLI",
            config_dir: ".gemini/antigravity-cli",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "astrbot",
            name: "AstrBot",
            config_dir: ".astrbot",
            skills_subdir: "data/skills",
            cli: "",
        },
        Tool {
            id: "augment",
            name: "Augment",
            config_dir: ".augment",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "autohand",
            name: "Autohand Code",
            config_dir: ".autohand",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "bob",
            name: "IBM Bob",
            config_dir: ".bob",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "codearts",
            name: "CodeArts Agent",
            config_dir: ".codeartsdoer",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "codebuddy",
            name: "CodeBuddy",
            config_dir: ".codebuddy",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "codemaker",
            name: "Codemaker",
            config_dir: ".codemaker",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "codestudio",
            name: "Code Studio",
            config_dir: ".codestudio",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "command-code",
            name: "Command Code",
            config_dir: ".commandcode",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "continue",
            name: "Continue",
            config_dir: ".continue",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "cortex",
            name: "Cortex Code",
            config_dir: ".snowflake/cortex",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "crush",
            name: "Crush",
            config_dir: ".config/crush",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "deepagents",
            name: "Deep Agents",
            config_dir: ".deepagents",
            skills_subdir: "agent/skills",
            cli: "",
        },
        Tool {
            id: "devin",
            name: "Devin for Terminal",
            config_dir: ".config/devin",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "droid",
            name: "Droid (Factory)",
            config_dir: ".factory",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "firebender",
            name: "Firebender",
            config_dir: ".firebender",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "forgecode",
            name: "ForgeCode",
            config_dir: ".forge",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "goose",
            name: "Goose",
            config_dir: ".config/goose",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "grok",
            name: "Grok Build",
            config_dir: ".grok",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "hermes",
            name: "Hermes Agent",
            config_dir: ".hermes",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "iflow",
            name: "iFlow CLI",
            config_dir: ".iflow",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "inference-sh",
            name: "inference.sh",
            config_dir: ".inferencesh",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "jazz",
            name: "Jazz",
            config_dir: ".jazz",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "junie",
            name: "Junie",
            config_dir: ".junie",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "kimchi",
            name: "Kimchi",
            config_dir: ".config/kimchi",
            skills_subdir: "harness/skills",
            cli: "",
        },
        Tool {
            id: "kiro",
            name: "Kiro CLI",
            config_dir: ".kiro",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "kode",
            name: "Kode",
            config_dir: ".kode",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "lingma",
            name: "Lingma",
            config_dir: ".lingma",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "mcpjam",
            name: "MCPJam",
            config_dir: ".mcpjam",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "mistral-vibe",
            name: "Mistral Vibe",
            config_dir: ".vibe",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "moxby",
            name: "Moxby",
            config_dir: ".moxby",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "mux",
            name: "Mux",
            config_dir: ".mux",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "ona",
            name: "Ona",
            config_dir: ".ona",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "openclaw",
            name: "OpenClaw",
            config_dir: ".openclaw",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "openhands",
            name: "OpenHands",
            config_dir: ".openhands",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "pi",
            name: "pi",
            config_dir: ".pi",
            skills_subdir: "agent/skills",
            cli: "",
        },
        Tool {
            id: "pochi",
            name: "Pochi",
            config_dir: ".pochi",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "neovate",
            name: "Neovate",
            config_dir: ".neovate",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "qoder",
            name: "Qoder",
            config_dir: ".qoder",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "qoder-cn",
            name: "Qoder CN",
            config_dir: ".qoder-cn",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "reasonix",
            name: "Reasonix",
            config_dir: ".reasonix",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "rovodev",
            name: "Rovo Dev",
            config_dir: ".rovodev",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "tabnine",
            name: "Tabnine CLI",
            config_dir: ".tabnine",
            skills_subdir: "agent/skills",
            cli: "",
        },
        Tool {
            id: "terramind",
            name: "Terramind",
            config_dir: ".terramind",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "tinycloud",
            name: "Tinycloud",
            config_dir: ".tinycloud",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "trae",
            name: "Trae",
            config_dir: ".trae",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "trae-cn",
            name: "Trae CN",
            config_dir: ".trae-cn",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "xdg-agents",
            name: "XDG agents dir (Amp/Replit/universal)",
            config_dir: ".config/agents",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "zcode",
            name: "ZCode",
            config_dir: ".zcode",
            skills_subdir: "skills",
            cli: "",
        },
        Tool {
            id: "zencoder",
            name: "Zencoder / Zenflow",
            config_dir: ".zencoder",
            skills_subdir: "skills",
            cli: "",
        },
    ];
    TOOLS
}

/// Detect tools present under `home` (their `config_dir` exists), returning each
/// with its resolved global skills directory.
pub fn detect(home: &Path) -> Vec<DetectedTool> {
    registry()
        .iter()
        .filter_map(|t| {
            let cfg = home.join(t.config_dir);
            cfg.is_dir().then(|| DetectedTool {
                id: t.id,
                name: t.name,
                skills_dir: cfg.join(t.skills_subdir),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn registry_covers_at_least_ten_tools_incl_canonical() {
        assert!(
            registry().len() >= 10,
            "registry should list >=10 tools, got {}",
            registry().len()
        );
        assert!(registry().iter().any(|t| t.config_dir == ".agents"));
        assert!(registry().iter().any(|t| t.id == "claude-code"));
    }

    #[test]
    fn registry_covers_the_vercel_skills_ecosystem() {
        // Entries mined from vercel-labs/skills src/agents.ts (the SOURCE registry, not its
        // README) — each (id, config_dir, skills_subdir) checked against their globalSkillsDir.
        let home = tempfile::tempdir().unwrap();
        for (dir, id, skills) in [
            (".pi", "pi", ".pi/agent/skills"),
            (".config/goose", "goose", ".config/goose/skills"),
            (".trae", "trae", ".trae/skills"),
            (".factory", "droid", ".factory/skills"),
            (".continue", "continue", ".continue/skills"),
            (".snowflake/cortex", "cortex", ".snowflake/cortex/skills"),
            (".deepagents", "deepagents", ".deepagents/agent/skills"),
            (".config/kimchi", "kimchi", ".config/kimchi/harness/skills"),
            (".tabnine", "tabnine", ".tabnine/agent/skills"),
            (".config/agents", "xdg-agents", ".config/agents/skills"),
            (".openhands", "openhands", ".openhands/skills"),
            (".goose-nonexistent", "", ""), // guard: loop shape sanity
        ] {
            if id.is_empty() {
                continue;
            }
            std::fs::create_dir_all(home.path().join(dir)).unwrap();
            let found = detect(home.path());
            let hit = found.iter().find(|d| d.id == id);
            assert!(hit.is_some(), "{id} not detected after creating {dir}");
            assert_eq!(
                hit.unwrap().skills_dir,
                home.path()
                    .join(skills.replace('/', std::path::MAIN_SEPARATOR_STR)),
                "{id} skills dir"
            );
        }
        assert!(
            registry().len() >= 60,
            "expected the expanded registry, got {}",
            registry().len()
        );
    }

    #[test]
    fn detects_only_tools_whose_config_dir_exists() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        fs::create_dir_all(home.path().join(".agents")).unwrap();

        let found = detect(home.path());
        let ids: Vec<_> = found.iter().map(|d| d.id).collect();

        assert!(ids.contains(&"claude-code"));
        assert!(ids.contains(&"agents"));
        assert!(
            !ids.contains(&"cursor"),
            "cursor has no config dir in the fixture"
        );

        let claude = found.iter().find(|d| d.id == "claude-code").unwrap();
        assert_eq!(
            claude.skills_dir,
            home.path().join(".claude").join("skills")
        );
    }
}
