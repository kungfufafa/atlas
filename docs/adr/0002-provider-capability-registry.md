# ADR 0002 — Capability-Based Provider Registry

Atlas routes provider work by declared capability instead of selecting a
provider type in orchestration code. Provider-specific protocol behavior stays
inside an adapter; the capability resolver, routing policy, and UI consume the
same manifest contract.

## Decision

Each adapter registers a `ProviderCapabilityManifestV1` and its executable
handlers. The manifest separates four facts that must not be conflated:

- `native` — what the upstream provider documents.
- `implementation` — whether this Atlas adapter can execute the capability.
- `modelDefault` and model claims — what is known for a concrete model.
- instance override — evidence recorded by a workspace admin.

A capability is selectable only when Atlas has both verified support and an
implementation. `unknown` is fail-closed. An admin override may change support
evidence, but cannot install a missing handler or discard request constraints.

Capability IDs are open strings. Atlas ships standard IDs such as
`chat.completion`, `chat.input.image`, `audio.transcription`,
`image.generation`, and `image.understanding`; an adapter may add vendor IDs
without changing the resolver.

## Versioning

The manifest has independent `schemaVersion`, `adapterApiVersion`, and
per-capability `contractVersion` fields. Runtime validation rejects unsupported
versions rather than interpreting them optimistically. A future incompatible
shape or handler contract gets a new version and an explicit migration path.

## Partial and model-dependent support

Provider-level native support is not proof that every model supports a feature.
Model claims refine the provider default, and constraints describe accepted
values or incompatible request features. Resolution preserves constraints while
applying stronger evidence. This covers providers that expose one API surface
but vary support by model, deployment, region, or endpoint.

The admin evidence UI currently stores provider-instance overrides. Because an
override applies to every configured model in that instance, the UI requires
admins to verify every configured model before selecting `Supported`.

## Routing and fallback

Routable specialist capabilities use a workspace binding with one primary and
ordered fallbacks. The resolver considers a fallback only before a request is
sent, for example when credentials, the model, verified support, or an adapter
handler are unavailable. Atlas does not retry on another provider after a
provider request starts; this avoids duplicate work and charges.

Chat capabilities use the same resolver as specialist media operations. Text,
structured output, streaming, tool use, reasoning, native web search, and image
input are checked before the adapter call. Unsupported streaming may degrade to
non-streaming only through an explicit policy path; unsupported or unknown
required capabilities return structured errors.

## Cross-provider design review

- **OpenAI** exercises chat, vision, audio transcription, image generation,
  tools, structured output, and endpoint-sensitive native web search. Its
  adapter proves that one provider can implement several unrelated handlers.
- **Gemini** exercises multimodal chat plus audio transcription and image
  generation with model-specific declarations and request constraints. It
  proves that provider support and model support must remain separate.
- **Fireworks** documents vision, audio, and image generation, while Atlas does
  not yet implement every native operation. It proves that `native: supported`
  must never imply `implementation: available`.
- **Custom OpenAI-compatible** starts with unknown evidence and admin-supplied
  endpoint/model configuration. It proves that unknown providers can be added
  without optimistic feature assumptions.

## Configuration boundary

The provider catalog owns setup metadata such as credentials, base URL, model
entry, and discovery. Adding a provider means adding a catalog definition and
adapter registration; orchestration code does not gain another provider-name
branch. Workspace admins configure provider instances, capability evidence, and
specialist routing through Settings.

## Verification strategy

- Contract tests reject version mismatches, invalid claims, missing handler
  parity, unsupported automatic routing, and unknown evidence.
- Synthetic adapter tests prove new provider and vendor capability IDs work
  without editing resolver logic.
- Unit tests cover selection, ordered pre-request fallback, constraints, and
  structured errors.
- Recorded real-provider cassette tests replay image understanding and audio
  transcription offline. Each new provider operation must first record one real
  successful HTTP exchange; credentials are removed from the cassette.
- UI tests cover catalog-driven options, stale targets, evidence overrides,
  disabled handlers, save/reload, and RBAC. Browser QA exercises the same flow
  as a workspace admin.

## Consequences

Provider-specific HTTP and SDK details remain intentionally adapter-local.
Atlas can expose upstream support only after an executor exists and a real
integration succeeds. Until then, the capability remains visible as native but
unavailable, rather than being silently routed or falsely advertised.
