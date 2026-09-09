import { writeFile } from "node:fs/promises";
import {
  atlasSourceHashes,
  hermesSourceHashes,
  sha256,
} from "/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/provenance.ts";
import { fileControlHashes } from "/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-native-files-mimo-v2/file-run.ts";

const at = new Date().toISOString();
const productionFiles = await atlasSourceHashes(
  "/Users/apriansyahrs/Documents/Code/atlas"
);
const controlFiles = await fileControlHashes();
const hermesFiles = await hermesSourceHashes(
  "/private/tmp/atlas-hermes-evaluation/source"
);
const record = {
  at,
  candidateSourceHash: sha256(JSON.stringify(productionFiles)),
  completedAt: new Date().toISOString(),
  controlFiles,
  hermesFiles,
  productionFiles,
};
await writeFile(
  "/private/tmp/atlas-native-file-delivery-audit/v2-final-readiness/source-current.json",
  JSON.stringify(record, null, 2) + "\n",
  { flag: "wx" }
);
console.log(
  JSON.stringify({
    at: record.at,
    candidateSourceHash: record.candidateSourceHash,
    completedAt: record.completedAt,
    controlFiles: Object.keys(controlFiles).length,
    hermesFiles: Object.keys(hermesFiles).length,
    productionFiles: Object.keys(productionFiles).length,
  })
);
