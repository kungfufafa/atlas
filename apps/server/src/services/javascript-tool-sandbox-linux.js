import { cc } from "bun:ffi";
import landlockSource from "./javascript-tool-sandbox-linux.c" with {
  type: "file",
};

if (process.platform !== "linux") {
  console.error("The Landlock custom-tool launcher only supports Linux.");
  process.exit(1);
}

try {
  const library = cc({
    source: landlockSource,
    symbols: {
      atlas_landlock_and_exec: {
        args: [],
        returns: "int",
      },
    },
  });

  const exitCode = library.symbols.atlas_landlock_and_exec();
  library.close();
  process.exit(exitCode || 1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to initialize the Linux Landlock sandbox: ${message}`);
  process.exit(1);
}
