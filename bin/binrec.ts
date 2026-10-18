#!/usr/bin/env bun
import { binrec } from "../src/binrec.ts";

const b = binrec.create();

const usage = `Usage:
  binrec install           Create ${b.path} and show how to add it to PATH
  binrec install <bin>     Install a shim for <bin> in ${b.path}
  binrec rec [--records <dir>] <path> [...]
                           Run <path> passing stdio through and record it in ${b.records}`;

const install = async (command?: string) => {
  if (!command) {
    await b.init();
    console.log(`binrec bin directory ready: ${b.path}`);
    console.log("");
    console.log("Add it to your PATH by appending this line to ~/.bashrc:");
    console.log("");
    console.log(`  export PATH="$PATH:${b.path}"`);
    console.log("");
    console.log("Then reload your shell with: source ~/.bashrc");
    return 0;
  }

  try {
    const shimPath = await b.install(command);
    console.log(`Installed ${shimPath}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
};

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "install":
    process.exit(await install(rest[0]));
  case "rec": {
    let records = b.records;
    if (rest[0] === "--records") {
      records = rest[1] ?? records;
      rest.splice(0, 2);
    }
    if (!rest[0]) {
      console.error(usage);
      process.exit(1);
    }
    const { exitCode } = await binrec.rec(rest[0], rest.slice(1), { records });
    process.exit(exitCode);
  }
  default:
    console.error(usage);
    process.exit(command ? 1 : 0);
}
