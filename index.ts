import { runCli } from "./src/cli.ts";

export { binrec, rec, defaultPath } from "./src/binrec.ts";
export type {
  Binrec,
  CreateOptions,
  RecOptions,
  RecResult,
  RecordLine,
  Session,
} from "./src/binrec.ts";

// The bundled dist/binrec.js is both the library and the `binrec` bin.
if (import.meta.main) await runCli(process.argv.slice(2));
