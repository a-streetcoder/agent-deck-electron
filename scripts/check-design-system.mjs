import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const sourceRoot = path.resolve("apps/web/src");
const tokenFile = path.join(sourceRoot, "design-system/tokens.css");
const approvedRawColorFiles = new Set([
  path.join(sourceRoot, "components/browser/picker.ts"),
  path.join(sourceRoot, "components/diff/EditorIcons.tsx"),
  path.join(sourceRoot, "components/diff/JetBrainsIcons.tsx"),
]);
const approvedArbitraryVisualFiles = new Set([
  path.join(sourceRoot, "design-system/markdown/MarkdownDocument.tsx"),
  path.join(sourceRoot, "design-system/markdown/MarkdownInline.tsx"),
]);
const sidebarWordmarkFile = path.join(sourceRoot, "components/Sidebar.tsx");
const defaultTypeSize = /\btext-(xs|sm|base|lg|xl|2xl)\b/g;

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  });
}

const sourceFiles = filesUnder(sourceRoot).filter((file) => /\.(css|ts|tsx)$/.test(file));
const tokenSource = fs.readFileSync(tokenFile, "utf8");
const declaredTokens = new Set(
  [...tokenSource.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]),
);
const failures = [];

function report(file, message) {
  failures.push(`${path.relative(process.cwd(), file)}: ${message}`);
}

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");

  for (const match of source.matchAll(/var\((--[\w-]+)/g)) {
    if (!declaredTokens.has(match[1])) report(file, `undeclared token ${match[1]}`);
  }

  if (file !== tokenFile && !approvedRawColorFiles.has(file)) {
    const rawColors = new Set(
      [...source.matchAll(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi)].map((match) => match[0]),
    );
    for (const rawColor of rawColors) report(file, `raw color ${rawColor} must be a token`);
  }

  if (file.endsWith(".tsx") && !file.includes(`${path.sep}design-system${path.sep}`)) {
    const nativeControls = new Set(
      [...source.matchAll(/<(button|input|textarea|select)\b/g)].map((match) => match[1]),
    );
    for (const nativeControl of nativeControls) {
      report(file, `raw <${nativeControl}> must use a design-system control`);
    }
  }

  for (const match of source.matchAll(defaultTypeSize)) {
    const index = match.index ?? 0;
    const lineStart = source.lastIndexOf("\n", index - 1) + 1;
    const lineEnd = source.indexOf("\n", index);
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const allowedSidebarWordmark =
      file === sidebarWordmarkFile && match[0] === "text-lg" && line.includes("font-pixel");
    if (!allowedSidebarWordmark) {
      report(file, `default Tailwind type size ${match[0]} must use a semantic token`);
    }
  }

  if (file.endsWith(".tsx") && !approvedArbitraryVisualFiles.has(file)) {
    const arbitraryVisuals = new Set(
      [
        ...source.matchAll(
          /(?:bg|text|border|ring|shadow|rounded|fill|stroke|outline)-\[[^\]]+\]/g,
        ),
      ].map((match) => match[0]),
    );
    for (const arbitraryVisual of arbitraryVisuals) {
      report(file, `arbitrary visual utility ${arbitraryVisual} must use a named token`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Design-system check failed (${failures.length}):\n${failures.join("\n")}`);
  process.exit(1);
}

console.log("Design-system check passed");
