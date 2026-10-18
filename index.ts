import { runCli } from "./src/cli.ts";

export { binrec, rec, play, playUi, defaultPath } from "./src/binrec.ts";
export type {
  Binrec,
  PlayOptions,
  PlayUiOptions,
  PlayUiServer,
  CommandStats,
  CreateOptions,
  InitShellOptions,
  InitShellResult,
  RecOptions,
  RecResult,
  RecordLine,
  Session,
  Stats,
} from "./src/binrec.ts";

// The bundled dist/binrec.js is both the library and the `binrec` bin.
if (import.meta.main) await runCli(process.argv.slice(2));
