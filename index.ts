import { runCli } from "./src/cli.ts";

export { binrec, rec, play, playTree, playUi, exportVideo, asTrees, sessionTree, defaultPath } from "./src/binrec.ts";
export type {
  Binrec,
  PlayOptions,
  PlayUiOptions,
  PlayUiServer,
  PlayUiSource,
  CommandStats,
  ExportOptions,
  ExportResult,
  VideoFormat,
  CreateOptions,
  RecOptions,
  RecResult,
  RecordLine,
  Session,
  TreeSession,
  Stats,
} from "./src/binrec.ts";

// The bundled dist/binrec.js is both the library and the `binrec` bin.
if (import.meta.main) await runCli(process.argv.slice(2));
