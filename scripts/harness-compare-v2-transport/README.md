# Comparison transport revision 2

This separately versioned copy preserves the frozen comparison broker's model,
generation controls, task tools, fixture contents, budgets and accounting behavior.
It adds an optional absolute `workspaceRoot` to registration so an evaluator can
keep private trace names outside the model's current directory. Omitting the option
retains the original workspace layout. Empty and relative explicit paths fail.

The original `scripts/harness-compare/` source and completed studies remain intact.
This module alone does not establish blinding: amended orchestrators must use opaque
transport/session identifiers and bind their private mapping into the evidence.
Native request serialization is handled by the separately revised product proxy.

`legacy-proxy.test.ts` retains the original broker behavior checks; `workspace.test.ts`
verifies both harnesses' actual file effects and unchanged provider request bodies.
Tests use localhost servers, simulated upstream responses and a synthetic credential.
