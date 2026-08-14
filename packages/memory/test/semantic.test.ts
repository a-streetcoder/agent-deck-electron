import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  centeredCosineScores,
  cosineSimilarity,
  meanCenter,
  informativeTerms,
  searchMemories,
  semanticInformativeTerms,
  semanticSearchMemories,
  setMemoryStatus,
  writeMemory,
  type Embedder,
  type MemoryStore,
} from "../src/index.ts";

let store: MemoryStore;

beforeEach(() => {
  store = {
    baseDir: mkdtempSync(path.join(tmpdir(), "agent-deck-mem-")),
    projectPath: mkdtempSync(path.join(tmpdir(), "proj-")),
  };
});

function addMemory(
  title: string,
  summary: string,
  body = `${title} body`,
  options: { tags?: string[]; confirmNew?: boolean } = {},
): void {
  const result = writeMemory(store, {
    type: "context",
    title,
    summary,
    body,
    tags: options.tags,
    confirmNew: options.confirmNew,
  });
  if (!result.ok) throw new Error(`memory setup failed: ${result.reason}`);
}

function mappedEmbedder(
  queries: Record<string, number[]>,
  documents: Record<string, number[]>,
  onTexts?: (texts: string[]) => void,
): Embedder {
  return {
    async embed(texts) {
      onTexts?.(texts);
      return texts.map((text, index) => {
        if (index === 0) return queries[text] ?? [0, 0, 0];
        const title = text.split("\n", 1)[0]!;
        return documents[title] ?? [0, 0, 0];
      });
    },
  };
}

const DOCUMENT_VECTORS: Record<string, number[]> = {
  "Login credentials": [1, 0, 0],
  "Schema migrations": [0, 1, 0],
  "Release pipeline": [0, 0, 1],
};

function seedCalibratedCorpus(): void {
  addMemory("Login credentials", "Where the oauth token lives");
  addMemory("Schema migrations", "Applying schema changes to postgres");
  addMemory("Release pipeline", "How code ships through CI");
}

describe("semantic scoring math", () => {
  it("keeps native semantic overlap tokenization separate from lexical search", () => {
    const text = "agent please UI running parties cache 123";
    expect([...semanticInformativeTerms(text)].sort()).toEqual(["cache", "partie", "runn"]);
    expect([...informativeTerms(text)].sort()).toEqual(
      ["123", "agent", "cache", "party", "please", "run", "ui"].sort(),
    );
  });

  it("mean-centers vectors around their centroid", () => {
    expect(
      meanCenter([
        [1, 0],
        [3, 0],
      ]),
    ).toEqual([
      [-1, 0],
      [1, 0],
    ]);
  });

  it("computes cosine and uses raw cosine for a one-document corpus", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(centeredCosineScores([1, 0], [[1, 0]])).toEqual([1]);
  });

  it("centers on documents only and abstains when the query is their centroid", () => {
    const docs = [
      [1, 0],
      [0, 1],
    ];
    expect(centeredCosineScores([1, 0], docs)[0]).toBeGreaterThan(
      centeredCosineScores([1, 0], docs)[1]!,
    );
    expect(centeredCosineScores([0.5, 0.5], docs)).toEqual([]);
  });
});

describe("semanticSearchMemories native qualification", () => {
  beforeEach(seedCalibratedCorpus);

  it.each([
    {
      name: "keeps a strong semantic match corroborated by one curated term",
      query: "oauth whereabouts",
      vector: [1, 0, 0],
      expected: ["Login credentials"],
    },
    {
      name: "keeps a weak semantic match only with two curated terms",
      query: "login token",
      vector: [1 / 3, 4 / 3, -2 / 3],
      expected: ["Login credentials"],
    },
    {
      name: "abstains from a strong but lexically uncorroborated match",
      query: "authenticate signin",
      vector: [1, 0, 0],
      expected: [],
    },
    {
      name: "abstains when lexical qualification has a hybrid score below the floor",
      query: "login token",
      vector: [-1, 0, 0],
      expected: [],
    },
  ])("$name", async ({ query, vector, expected }) => {
    const hits = await semanticSearchMemories(
      store,
      query,
      mappedEmbedder({ [query]: vector }, DOCUMENT_VECTORS),
    );
    expect(hits.map((hit) => hit.record.title)).toEqual(expected);
  });

  it("takes the weak path when raw cosine is strictly between 0 and 0.5", async () => {
    const isolated: MemoryStore = {
      baseDir: mkdtempSync(path.join(tmpdir(), "agent-deck-mem-")),
      projectPath: mkdtempSync(path.join(tmpdir(), "proj-")),
    };
    for (const [title, summary] of [
      ["Login token", "credential location"],
      ["Release notes", "deployment history"],
    ] as const) {
      const result = writeMemory(isolated, {
        type: "context",
        title,
        summary,
        body: "body",
        confirmNew: true,
      });
      if (!result.ok) throw new Error("setup failed");
    }
    const query = "login token";
    const hits = await semanticSearchMemories(
      isolated,
      query,
      mappedEmbedder(
        { [query]: [0.3, Math.sqrt(1 - 0.3 ** 2)] },
        { "Login token": [1, 0], "Release notes": [-1, 0] },
      ),
    );
    expect(hits.map((hit) => hit.record.title)).toEqual(["Login token"]);
  });

  it("retains two positive qualified hits within 60% of the best", async () => {
    const isolated: MemoryStore = {
      baseDir: mkdtempSync(path.join(tmpdir(), "agent-deck-mem-")),
      projectPath: mkdtempSync(path.join(tmpdir(), "proj-")),
    };
    for (const [title, summary] of [
      ["Primary cache", "artifact location"],
      ["Secondary cache", "artifact mirror"],
      ["Release notes", "deployment history"],
    ] as const) {
      const result = writeMemory(isolated, {
        type: "context",
        title,
        summary,
        body: "body",
        confirmNew: true,
      });
      if (!result.ok) throw new Error("setup failed");
    }
    const query = "cache artifact";
    const hits = await semanticSearchMemories(
      isolated,
      query,
      mappedEmbedder(
        { [query]: [1, 0] },
        {
          "Primary cache": [1, 0],
          "Secondary cache": [0.8, 0.6],
          "Release notes": [-1.8, -0.6],
        },
      ),
    );
    expect(hits.map((hit) => hit.record.title)).toEqual(["Primary cache", "Secondary cache"]);
  });

  it("uses title/summary/tags for qualification but not incidental body vocabulary", async () => {
    const bodyOnly = await semanticSearchMemories(
      store,
      "body whereabouts",
      mappedEmbedder({ "body whereabouts": [1, 0, 0] }, DOCUMENT_VECTORS),
    );
    expect(bodyOnly).toEqual([]);

    // Tags are curated retrieval fields and do count.
    addMemory("Build cache", "Remote artifacts", "body", { tags: ["cache", "artifact"] });
    const docs = Object.fromEntries(
      Object.entries(DOCUMENT_VECTORS).map(([title, vector]) => [title, [...vector, 0]]),
    );
    docs["Build cache"] = [0, 0, 0, 1];
    const query = "cache artifact";
    const hits = await semanticSearchMemories(
      store,
      query,
      mappedEmbedder({ [query]: [0, 0, 0, 1] }, docs),
    );
    expect(hits[0]?.record.title).toBe("Build cache");
  });

  it("embeds title + summary + the trimmed first 600 body characters", async () => {
    const isolated: MemoryStore = {
      baseDir: mkdtempSync(path.join(tmpdir(), "agent-deck-mem-")),
      projectPath: mkdtempSync(path.join(tmpdir(), "proj-")),
    };
    const body = `${"a".repeat(598)}  TAIL`;
    const result = writeMemory(isolated, {
      type: "context",
      title: "Bounded document",
      summary: "alpha beta",
      body,
    });
    if (!result.ok) throw new Error("setup failed");

    let embedded: string[] = [];
    await semanticSearchMemories(
      isolated,
      "alpha beta",
      mappedEmbedder({ "alpha beta": [1, 0] }, { "Bounded document": [1, 0] }, (texts) => {
        embedded = texts;
      }),
    );
    expect(embedded[1]).toBe(`Bounded document\nalpha beta\n${"a".repeat(598)}`);
    expect(embedded[1]).not.toContain("TAIL");
  });

  it("requires two lexical terms for a single-document corpus despite saturated raw cosine", async () => {
    const isolated: MemoryStore = {
      baseDir: mkdtempSync(path.join(tmpdir(), "agent-deck-mem-")),
      projectPath: mkdtempSync(path.join(tmpdir(), "proj-")),
    };
    const result = writeMemory(isolated, {
      type: "context",
      title: "Login credentials",
      summary: "oauth token location",
      body: "body",
    });
    if (!result.ok) throw new Error("setup failed");
    const embedder = mappedEmbedder(
      { oauth: [1, 0], "oauth token": [1, 0] },
      { "Login credentials": [1, 0] },
    );

    expect(await semanticSearchMemories(isolated, "oauth", embedder)).toEqual([]);
    expect(
      (await semanticSearchMemories(isolated, "oauth token", embedder)).map(
        (hit) => hit.record.title,
      ),
    ).toEqual(["Login credentials"]);
  });

  it.each([
    {
      name: "count 4 remains discriminative despite exceeding 20%",
      corpusSize: 10,
      count: 4,
      hit: true,
    },
    {
      name: "count 5/25 remains discriminative at exactly 20%",
      corpusSize: 25,
      count: 5,
      hit: true,
    },
    { name: "count 6/25 is excluded above 20%", corpusSize: 25, count: 6, hit: false },
  ])("keeps the native DF boundary: $name", async ({ corpusSize, count, hit }) => {
    const crowded: MemoryStore = {
      baseDir: mkdtempSync(path.join(tmpdir(), "agent-deck-mem-")),
      projectPath: mkdtempSync(path.join(tmpdir(), "proj-")),
    };
    const documents: Record<string, number[]> = {};
    let targetTitle = "";
    for (let index = 0; index < corpusSize; index += 1) {
      const title = `${index < count ? "Calibration " : ""}Topic variant${index}`;
      const result = writeMemory(crowded, {
        type: "context",
        title,
        summary: `Distinct subject variant${index}`,
        body: "body",
        confirmNew: true,
      });
      if (!result.ok) throw new Error("setup failed");
      if (index === 0) targetTitle = title;
      documents[title] = index === 0 ? [1, 0] : [0, 1];
    }
    const hits = await semanticSearchMemories(
      crowded,
      "calibration",
      mappedEmbedder({ calibration: [1, 0] }, documents),
    );
    expect(hits.map((entry) => entry.record.title)).toEqual(hit ? [targetTitle] : []);
  });

  it.each([
    { name: "throws", vectors: null },
    { name: "returns too few vectors", vectors: [[1, 0]] },
    { name: "returns ragged vectors", vectors: [[1, 0], [1], [0, 1], [1, 1]] },
    {
      name: "returns non-finite vectors",
      vectors: [
        [1, 0],
        [NaN, 0],
        [0, 1],
        [1, 1],
      ],
    },
  ])("falls back to lexical search when the embedder $name", async ({ vectors }) => {
    const broken: Embedder = {
      async embed() {
        if (vectors === null) throw new Error("model unavailable");
        return vectors;
      },
    };
    const hits = await semanticSearchMemories(store, "oauth token", broken);
    expect(hits[0]?.record.title).toBe("Login credentials");
    expect(await semanticSearchMemories(store, "quantum helicopter", broken)).toEqual([]);
  });

  it("uses pinned metadata only to break equal scores", async () => {
    const isolated: MemoryStore = {
      baseDir: mkdtempSync(path.join(tmpdir(), "agent-deck-mem-")),
      projectPath: mkdtempSync(path.join(tmpdir(), "proj-")),
    };
    const alpha = writeMemory(isolated, {
      type: "context",
      title: "Alpha cache",
      summary: "shared artifact",
      body: "body",
    });
    const beta = writeMemory(isolated, {
      type: "context",
      title: "Beta cache",
      summary: "shared artifact",
      body: "body",
      confirmNew: true,
    });
    const gamma = writeMemory(isolated, {
      type: "context",
      title: "Release notes",
      summary: "deployment history",
      body: "body",
      confirmNew: true,
    });
    if (!alpha.ok || !beta.ok || !gamma.ok) throw new Error("setup failed");
    setMemoryStatus(isolated, beta.record.id, "pinned");
    const betaVector = [Math.cos(-0.01), Math.sin(-0.01)];
    const documents = {
      "Alpha cache": [1, 0],
      "Beta cache": betaVector,
      "Release notes": [-1 - betaVector[0]!, -betaVector[1]!],
    };

    // Alpha's score is slightly higher, but both land in the same 0.02 bucket.
    // Native therefore lets pinned metadata settle this near-tie in Beta's favor.
    const tied = await semanticSearchMemories(
      isolated,
      "cache artifact",
      mappedEmbedder({ "cache artifact": [Math.cos(0.48), Math.sin(0.48)] }, documents),
    );
    expect(tied[0]?.record.title).toBe("Beta cache");

    const semanticallyBetter = await semanticSearchMemories(
      isolated,
      "cache artifact",
      mappedEmbedder({ "cache artifact": [1, 0] }, documents),
    );
    expect(semanticallyBetter[0]?.record.title).toBe("Alpha cache");
  });

  it("keeps only qualified hits within 60% of the best score before applying limit", async () => {
    const query = "login token schema changes";
    const hits = await semanticSearchMemories(
      store,
      query,
      mappedEmbedder({ [query]: [1, 0, 0] }, DOCUMENT_VECTORS),
      { limit: 8 },
    );
    expect(hits.map((hit) => hit.record.title)).toEqual(["Login credentials"]);
    expect(searchMemories(store, query).length).toBeGreaterThan(1);
  });

  it("returns nothing for an empty query or zero limit", async () => {
    const embedder = mappedEmbedder({}, DOCUMENT_VECTORS);
    expect(await semanticSearchMemories(store, "   ", embedder)).toEqual([]);
    expect(await semanticSearchMemories(store, "oauth token", embedder, { limit: 0 })).toEqual([]);
  });
});
