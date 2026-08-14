export type InjectedCommandId = `built-in:${string}` | `library:${string}`;
export type InjectedCommandSource = "built-in" | "library";
export type InjectedCommandStatus = "enabled" | "disabled";

/** App-owned injected slash-command catalog record returned by the resource API. */
export interface InjectedCommandRecord {
  id: InjectedCommandId;
  slashName: `/${string}`;
  title: string;
  description: string;
  source: InjectedCommandSource;
  /** Execution filenames and filesystem locations are intentionally server-private. */
  status: InjectedCommandStatus;
}
