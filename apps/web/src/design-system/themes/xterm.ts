import type { ITheme } from "@xterm/xterm";

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Builds xterm's imperative theme from the same CSS tokens as the renderer. */
export function createXtermTheme(): ITheme {
  return {
    background: token("--color-terminal-background"),
    foreground: token("--color-terminal-foreground"),
    cursor: token("--color-terminal-cursor"),
    selectionBackground: token("--color-terminal-selection"),
    black: token("--color-terminal-black"),
    red: token("--color-terminal-red"),
    green: token("--color-terminal-green"),
    yellow: token("--color-terminal-yellow"),
    blue: token("--color-terminal-blue"),
    magenta: token("--color-terminal-magenta"),
    cyan: token("--color-terminal-cyan"),
    white: token("--color-terminal-white"),
    brightBlack: token("--color-terminal-bright-black"),
    brightRed: token("--color-terminal-bright-red"),
    brightGreen: token("--color-terminal-bright-green"),
    brightYellow: token("--color-terminal-bright-yellow"),
    brightBlue: token("--color-terminal-bright-blue"),
    brightMagenta: token("--color-terminal-bright-magenta"),
    brightCyan: token("--color-terminal-bright-cyan"),
    brightWhite: token("--color-terminal-bright-white"),
  };
}

export function getTerminalFontFamily(): string {
  return token("--font-mono");
}
