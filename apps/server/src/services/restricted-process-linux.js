import { cc } from "bun:ffi";
import source from "./restricted-process-linux.c" with { type: "file" };

try {
  const library = cc({
    source,
    symbols: { atlas_restricted_process_exec: { args: [], returns: "int" } },
  });
  const status = library.symbols.atlas_restricted_process_exec();
  library.close();
  process.exit(status || 1);
} catch (error) {
  console.error(
    `Unable to initialize required Python/Bash sandbox: ${String(error)}`
  );
  process.exit(1);
}
