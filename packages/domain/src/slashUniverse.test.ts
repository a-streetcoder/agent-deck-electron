import { describe, expect, it } from "vitest";
import type { SlashUniverse, SlashUniverseItem } from "@agent-deck/contracts";
import {
  EMPTY_SLASH_UNIVERSE,
  isEmpty,
  matches,
  materialize,
  rows,
  selectionsAfterAdding,
  titleGenerationSource,
} from "./slashUniverse.ts";

function skill(
  overrides: Partial<SlashUniverseItem> & Pick<SlashUniverseItem, "id">,
): SlashUniverseItem {
  return {
    kind: "skill",
    displayName: "Review",
    isActive: false,
    skillName: "review",
    body: "Review body",
    ...overrides,
  };
}

function prompt(
  overrides: Partial<SlashUniverseItem> & Pick<SlashUniverseItem, "id">,
): SlashUniverseItem {
  return {
    kind: "prompt",
    displayName: "Global Prompt",
    isActive: false,
    body: "Use this prompt",
    ...overrides,
  };
}

function command(
  overrides: Partial<SlashUniverseItem> & Pick<SlashUniverseItem, "id">,
): SlashUniverseItem {
  return {
    kind: "command",
    displayName: "help",
    isActive: true,
    slashName: "/help",
    ...overrides,
  };
}

function loop(
  overrides: Partial<SlashUniverseItem> & Pick<SlashUniverseItem, "id">,
): SlashUniverseItem {
  return {
    kind: "loop",
    displayName: "Create New Loop…",
    isActive: true,
    ...overrides,
  };
}

describe("slash universe", () => {
  it("treats an empty general-chat universe as empty", () => {
    expect(isEmpty(EMPTY_SLASH_UNIVERSE)).toBe(true);
    expect(
      isEmpty({ commands: [], prompts: [], skills: [], loops: [] } satisfies SlashUniverse),
    ).toBe(true);
    expect(
      isEmpty({
        commands: [],
        prompts: [],
        skills: [skill({ id: "skill:global:review" })],
        loops: [],
      }),
    ).toBe(false);
  });

  it("materializes a single active skill as a slash invocation", () => {
    const active = skill({
      id: "skill:active",
      displayName: "Review",
      scopeLabel: "Project",
      isActive: true,
      skillName: "review",
      body: "Review body",
    });

    expect(materialize([active], "")).toBe("/skill:review");
    expect(materialize([active], "check this")).toBe("/skill:review\ncheck this");
  });

  it("inlines multiple skill bodies with blank lines, even when one is active", () => {
    const activeSkill = skill({
      id: "skill:active",
      displayName: "Review",
      scopeLabel: "Project",
      isActive: true,
      skillName: "review",
      body: "Review body",
    });
    const collection = skill({
      id: "collection:plan",
      displayName: "Plan",
      scopeLabel: "Library",
      isActive: false,
      skillName: "Plan",
      body: "Plan body",
    });

    expect(selectionsAfterAdding(collection, [activeSkill]).map((item) => item.id)).toEqual([
      activeSkill.id,
      collection.id,
    ]);
    expect(materialize([activeSkill, collection], "check this")).toBe(
      "Review body\n\nPlan body\n\ncheck this",
    );
    expect(titleGenerationSource([activeSkill, collection], "check this")).toBe("check this");
  });

  it("replaces skills when a command or prompt is added", () => {
    const review = skill({
      id: "skill:active",
      scopeLabel: "Project",
      isActive: true,
    });
    const help = command({ id: "command:help" });
    const globalPrompt = prompt({
      id: "prompt:global",
      scopeLabel: "Global",
    });

    expect(selectionsAfterAdding(help, [review]).map((item) => item.id)).toEqual([help.id]);
    expect(selectionsAfterAdding(globalPrompt, [review]).map((item) => item.id)).toEqual([
      globalPrompt.id,
    ]);
  });

  it("replaces a command when a skill is added after it", () => {
    const help = command({ id: "command:help" });
    const review = skill({ id: "skill:active", isActive: true });

    expect(selectionsAfterAdding(review, [help]).map((item) => item.id)).toEqual([review.id]);
  });

  it("does not accumulate a duplicate skill id", () => {
    const review = skill({ id: "skill:active", isActive: true });

    expect(selectionsAfterAdding(review, [review])).toEqual([review]);
    expect(selectionsAfterAdding(review, [review]).map((item) => item.id)).toEqual([review.id]);
  });

  it("omits empty categories from the picker", () => {
    const universe: SlashUniverse = {
      commands: [],
      prompts: [
        prompt({
          id: "prompt:global",
          scopeLabel: "Global",
        }),
      ],
      skills: [
        skill({
          id: "skill:global",
          displayName: "Global Skill",
          scopeLabel: "Global",
          skillName: "Global Skill",
          body: "Use this skill",
        }),
      ],
      loops: [],
    };

    const pickerRows = rows(universe, { type: "picker" }, "");

    expect(pickerRows.map((row) => row.id)).toEqual(["cat:prompt", "cat:skill"]);
    expect(pickerRows.map((row) => (row.type === "category" ? row.label : undefined))).toEqual([
      "Prompts",
      "Skills",
    ]);
  });

  it("does not invent a send payload for a loop selection", () => {
    const createNew = loop({
      id: "loop:create-new",
      displayName: "Create New Loop…",
      scopeLabel: "Unsaved",
      isActive: true,
    });

    expect(materialize([createNew], "do not send")).toBe("do not send");
    expect(materialize([createNew], "")).toBe("");
  });

  it("uses user text only for command and skill titles and strips a seeded prompt body", () => {
    const help = command({ id: "command:help" });
    const review = skill({
      id: "skill:active",
      isActive: true,
      body: "Review body",
    });
    const seeded = prompt({
      id: "prompt:global",
      body: "Use this prompt",
    });

    expect(titleGenerationSource([], "  hello  ")).toBe("hello");
    expect(titleGenerationSource([help], "args")).toBe("args");
    expect(titleGenerationSource([review], "check this")).toBe("check this");
    expect(titleGenerationSource([seeded], "Use this prompt")).toBe("");
    expect(titleGenerationSource([seeded], "Use this prompt\nmore")).toBe("more");
    expect(titleGenerationSource([seeded], "different text")).toBe("different text");
    expect(titleGenerationSource([prompt({ id: "prompt:empty", body: "" })], "hello")).toBe(
      "hello",
    );
  });

  it("matches search fields and uses category headers for global search", () => {
    const help = command({
      id: "command:help",
      displayName: "Help",
      description: "Show help",
      slashName: "/help",
    });
    const seeded = prompt({
      id: "prompt:global",
      displayName: "Global Prompt",
      description: "seeded prompt body",
      body: "secret body text",
    });
    const review = skill({
      id: "skill:review",
      displayName: "Review",
      description: "look at the diff",
      isActive: true,
      body: "secret skill body",
    });
    const zebra = skill({
      id: "skill:zebra",
      displayName: "Zebra",
      isActive: false,
      body: "inactive skill",
    });
    const apple = skill({
      id: "skill:apple",
      displayName: "Apple",
      isActive: false,
      body: "another skill",
    });
    const createNew = loop({
      id: "loop:create-new",
      displayName: "Create New Loop…",
      description: "Configure and launch an unsaved loop for this transcript.",
    });
    const saved = loop({
      id: "loop:saved",
      displayName: "Nightly",
      description: "Ship nightly",
      searchText: "nightly goal",
      isActive: true,
      loopId: "saved",
    });
    const universe: SlashUniverse = {
      commands: [help],
      prompts: [seeded],
      skills: [zebra, review, apple],
      loops: [createNew, saved],
    };

    expect(matches(help, "HELP")).toBe(true);
    expect(matches(help, "/he")).toBe(true);
    expect(matches(seeded, "seeded prompt")).toBe(true);
    expect(matches(seeded, "secret body")).toBe(false);
    expect(matches(review, "look at the")).toBe(true);
    expect(matches(review, "secret skill")).toBe(false);
    expect(matches(saved, "nightly goal")).toBe(true);
    expect(matches(createNew, "xyz")).toBe(false);

    const searchRows = rows(universe, { type: "picker" }, "a");
    expect(
      searchRows
        .filter((row) => row.type === "header")
        .map((row) => (row.type === "header" ? row.label : "")),
    ).toEqual(["Prompts", "Skills", "Loops"]);
    expect(searchRows.some((row) => row.type === "header" && row.label === "Active")).toBe(false);
    expect(searchRows.some((row) => row.type === "header" && row.label === "Available")).toBe(
      false,
    );

    const skillItems = searchRows.flatMap((row) =>
      row.type === "item" && row.item.kind === "skill" ? [row.item.displayName] : [],
    );
    expect(skillItems).toEqual(["Review", "Apple", "Zebra"]);
  });

  it("applies Active/Available header rules in a category", () => {
    const active = skill({ id: "skill:active", displayName: "Active Skill", isActive: true });
    const available = skill({
      id: "skill:available",
      displayName: "Available Skill",
      isActive: false,
    });

    const both = rows(
      { commands: [], prompts: [], skills: [available, active], loops: [] },
      { type: "category", category: "skill" },
      "",
    );
    expect(both.map((row) => (row.type === "header" ? row.label : row.type))).toEqual([
      "Active",
      "item",
      "Available",
      "item",
    ]);
    expect(both.flatMap((row) => (row.type === "item" ? [row.item.displayName] : []))).toEqual([
      "Active Skill",
      "Available Skill",
    ]);

    const onlyAvailable = rows(
      { commands: [], prompts: [], skills: [available], loops: [] },
      { type: "category", category: "skill" },
      "",
    );
    expect(onlyAvailable.map((row) => (row.type === "header" ? row.label : row.type))).toEqual([
      "Available",
      "item",
    ]);

    const onlyActive = rows(
      { commands: [], prompts: [], skills: [active], loops: [] },
      { type: "category", category: "skill" },
      "",
    );
    expect(onlyActive.map((row) => (row.type === "header" ? row.label : row.type))).toEqual([
      "item",
    ]);
  });

  it("keeps Create New Loop first and matches query substrings of loops", () => {
    const createNew = loop({
      id: "loop:create-new",
      displayName: "Create New Loop…",
      scopeLabel: "Unsaved",
    });
    const saved = loop({
      id: "loop:saved",
      displayName: "Ship It",
      isActive: true,
      loopId: "saved",
    });
    const universe: SlashUniverse = {
      commands: [],
      prompts: [],
      skills: [],
      loops: [createNew, saved],
    };

    expect(matches(createNew, "loops")).toBe(true);
    expect(matches(createNew, "LOO")).toBe(true);
    expect(matches(createNew, "s")).toBe(true);

    const picker = rows(universe, { type: "picker" }, "");
    expect(picker).toEqual([
      { type: "category", id: "cat:loop", category: "loop", label: "Loops" },
    ]);

    const loopRows = rows(universe, { type: "category", category: "loop" }, "");
    expect(loopRows.flatMap((row) => (row.type === "item" ? [row.item.displayName] : []))).toEqual([
      "Create New Loop…",
      "Ship It",
    ]);
  });

  it("returns trimmed user text when nothing is selected", () => {
    expect(materialize([], "  hello  ")).toBe("hello");
    expect(materialize([command({ id: "command:help" })], "args")).toBe("/help args");
    expect(
      materialize(
        [
          skill({
            id: "skill:inactive",
            isActive: false,
            body: "Review body",
          }),
        ],
        "check this",
      ),
    ).toBe("Review body\n\ncheck this");
    expect(
      materialize(
        [
          prompt({
            id: "prompt:global",
            body: "Use this prompt",
          }),
        ],
        "Use this prompt",
      ),
    ).toBe("Use this prompt");
  });
});
