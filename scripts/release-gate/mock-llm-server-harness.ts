import { type Server, serve } from "bun";
import { getFreePort } from "./free-port";
import { recoveryFixtureUrls } from "./web-fetch-fixture";

function parseToolRecord(content: unknown): Record<string, unknown> {
  if (typeof content !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function resultTexts(value: unknown, field: string): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item === "object" &&
        item !== null &&
        typeof item[field] === "string"
          ? [item[field]]
          : []
      )
    : [];
}

export interface MockScenario {
  handler: (req: MockChatRequest) => MockResponseResult;
  id?: string;
  matcher: (req: MockChatRequest) => boolean;
}

export interface MockChatRequest {
  messages: Array<{
    content?: string | Array<{ text?: string; type: string }>;
    name?: string;
    role: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      function?: { name?: string };
      id: string;
    }>;
  }>;
  model?: string;
  stream?: boolean;
}

export interface MockResponseResult {
  content?: string;
  /** Keeps a deterministic turn active long enough to exercise real UI cancellation. */
  delayMs?: number;
  error?: { message: string; status: number };
  toolCalls?: Array<{
    args: Record<string, unknown>;
    id?: string;
    name: string;
  }>;
}

export class MockLLMServerHarness {
  private server: Server<any> | null = null;
  private customScenarios: MockScenario[] = [];
  public recordedRequests: MockChatRequest[] = [];
  public recordedToolCalls: Array<{
    args: Record<string, unknown>;
    name: string;
  }> = [];
  public port = 0;
  public baseUrl = "";

  async start(
    preferredPort?: number
  ): Promise<{ baseUrl: string; port: number }> {
    this.port = preferredPort ?? (await getFreePort());
    this.baseUrl = `http://127.0.0.1:${this.port}/v1`;

    this.server = serve({
      fetch: async (req: Request) => {
        const url = new URL(req.url);

        if (url.pathname === "/v1/models" && req.method === "GET") {
          return new Response(
            JSON.stringify({
              data: [
                { id: "mock-model", object: "model", owned_by: "local" },
                {
                  id: "qwen/qwen3.8-max-free",
                  object: "model",
                  owned_by: "tokenrouter",
                },
              ],
              object: "list",
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
          const body = (await req.json()) as MockChatRequest;
          this.recordedRequests.push(body);

          const result = this.resolveResponse(body);

          if (result.delayMs) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, result.delayMs);
              req.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true }
              );
            });
          }

          if (result.error) {
            return new Response(
              JSON.stringify({ error: { message: result.error.message } }),
              {
                headers: { "Content-Type": "application/json" },
                status: result.error.status,
              }
            );
          }

          if (result.toolCalls) {
            for (const tc of result.toolCalls) {
              this.recordedToolCalls.push({ args: tc.args, name: tc.name });
            }
          }

          if (body.stream) {
            return this.buildSseStreamResponse(result);
          }

          return this.buildJsonResponse(result);
        }

        return new Response("Not found", { status: 404 });
      },
      hostname: "127.0.0.1",
      port: this.port,
    });

    return { baseUrl: this.baseUrl, port: this.port };
  }

  registerScenario(scenario: MockScenario): void {
    this.customScenarios.unshift(scenario);
  }

  inspectRequests(): MockChatRequest[] {
    return [...this.recordedRequests];
  }

  inspectToolCalls(): Array<{ args: Record<string, unknown>; name: string }> {
    return [...this.recordedToolCalls];
  }

  reset(): void {
    this.recordedRequests = [];
    this.recordedToolCalls = [];
    this.customScenarios = [];
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }

  resolveResponse(req: MockChatRequest): MockResponseResult {
    // 1. Check custom registered scenarios first
    for (const scenario of this.customScenarios) {
      if (scenario.matcher(req)) {
        return scenario.handler(req);
      }
    }

    const messages = req.messages || [];
    const lastMsg = messages[messages.length - 1];
    const isPostTool = lastMsg?.role === "tool";
    const toolMsg = messages
      .slice()
      .reverse()
      .find((m) => m.role === "tool");
    const userMsg = messages
      .slice()
      .reverse()
      .find((m) => m.role === "user");

    let textPrompt = "";
    if (userMsg) {
      if (typeof userMsg.content === "string") {
        textPrompt = userMsg.content;
      } else if (Array.isArray(userMsg.content)) {
        textPrompt = userMsg.content
          .map((c: any) => (typeof c === "string" ? c : (c.text ?? "")))
          .join(" ");
      }
    } else if (typeof lastMsg?.content === "string") {
      textPrompt = lastMsg.content;
    }

    const runId = /release-gate-run: ([a-f0-9-]+)/i.exec(textPrompt)?.[1];
    const artifactPrefix = runId ? `artifacts/gate-${runId}-` : "artifacts/";
    const marker = runId ?? "deterministic-fixture";

    // These fixtures exercise Atlas's real tools and persisted bytes. They are
    // deterministic transport inputs, never evidence of model intelligence.
    if (runId && !isPostTool) {
      if (textPrompt.startsWith("History fixture: Apollo")) {
        return { content: "Recorded in this conversation." };
      }
      if (textPrompt.includes("For future presentations")) {
        return {
          toolCalls: [
            {
              args: {
                content: `User prefers concise, executive-friendly deliverables. Fixture ${runId}`,
                subject: `presentation_style_${runId}`,
              },
              name: "memory_write",
            },
          ],
        };
      }
      if (
        textPrompt.includes("How should you present technical explanations")
      ) {
        return {
          toolCalls: [{ args: { query: runId }, name: "memory_search" }],
        };
      }
      if (textPrompt.includes("When did I say Apollo launches")) {
        return {
          toolCalls: [
            { args: { query: `Apollo ${runId}` }, name: "search_chats" },
          ],
        };
      }
      if (textPrompt.includes("broken-source.atlas-gate.test")) {
        return {
          toolCalls: [
            {
              args: { url: recoveryFixtureUrls(runId).failure },
              name: "web_fetch",
            },
          ],
        };
      }
      if (textPrompt.includes("Inspect the uploaded Office fixture")) {
        const documentRef = /"documentRef"\s*:\s*"([^"]+)"/.exec(
          textPrompt
        )?.[1];
        return documentRef
          ? {
              toolCalls: [
                {
                  args: { documentRef, operation: "read" },
                  name: "office_document",
                },
              ],
            }
          : { content: "No original attachment reference was provided." };
      }
      if (textPrompt.includes("Start long research")) {
        return {
          content: "Deterministic long turn completed without cancellation.",
          delayMs: 30_000,
        };
      }
      if (
        textPrompt.includes("Make slide 4 more visual") ||
        textPrompt.includes("Update the deck")
      ) {
        return {
          toolCalls: [
            {
              args: {
                documentRef: `${artifactPrefix}atlas_overview.pptx`,
                edits: [
                  {
                    expectedMatches: 1,
                    find: "Detailed architecture explanation with repeated implementation details",
                    kind: "replace_text",
                    replace: textPrompt.includes("appendix")
                      ? "Appendix: https://bun.sh/docs"
                      : "Visual architecture summary",
                    unit: 4,
                  },
                ],
                operation: "edit",
                outputFilename: `gate-${runId}-atlas_overview_revised.pptx`,
              },
              name: "office_document",
            },
          ],
        };
      }
      if (textPrompt.includes("Add a downside case")) {
        return {
          toolCalls: [
            {
              args: {
                action: "add_sheet",
                columns: ["Scenario", "Revenue"],
                data: [
                  ["Downside Case", 90_000],
                  ["Run", marker],
                ],
                path: `${artifactPrefix}financial_model.xlsx`,
                sheetName: "Scenarios",
              },
              name: "spreadsheet",
            },
          ],
        };
      }
      const wantsBoth = textPrompt.includes("spreadsheet plus presentation");
      const wantsDeck =
        wantsBoth ||
        textPrompt.includes("Make a presentation") ||
        textPrompt.includes("Create a 3-slide presentation") ||
        textPrompt.includes("Create an 8-slide presentation") ||
        textPrompt.includes("board-ready");
      const wantsSheet = wantsBoth || textPrompt.includes("financial model");
      if (wantsDeck || wantsSheet) {
        const toolCalls: NonNullable<MockResponseResult["toolCalls"]> = [];
        if (wantsDeck) {
          const slideCount = textPrompt.includes("8-slide")
            ? 8
            : textPrompt.includes("3-slide")
              ? 3
              : 4;
          toolCalls.push({
            args: {
              path: `${artifactPrefix}${wantsBoth || textPrompt.includes("board-ready") ? "competitive_analysis" : "atlas_overview"}.pptx`,
              slides: Array.from({ length: slideCount }, (_, index) => ({
                bulletPoints: [
                  index === 3
                    ? "Detailed architecture explanation with repeated implementation details"
                    : `Verified fixture content ${marker}`,
                ],
                layout: "content",
                title: `Atlas ${marker} slide ${index + 1}`,
              })),
              title: `Atlas fixture ${marker}`,
            },
            name: "write_pptx",
          });
        }
        if (wantsSheet) {
          toolCalls.push({
            args: {
              action: "create",
              columns: ["Period", "Revenue"],
              data: [
                ["Q1", 100_000],
                ["Run", marker],
              ],
              path: `${artifactPrefix}financial_model.xlsx`,
              sheetName: "Projections",
            },
            name: "spreadsheet",
          });
        }
        return { toolCalls };
      }
    }

    if (runId && isPostTool && toolMsg) {
      const content =
        typeof toolMsg.content === "string" ? toolMsg.content : "";
      if (textPrompt.includes("broken-source.atlas-gate.test")) {
        const result = parseToolRecord(content);
        const urls = recoveryFixtureUrls(runId);
        if (typeof result.error === "string") {
          return {
            toolCalls: [{ args: { url: urls.success }, name: "web_fetch" }],
          };
        }
        return result.status === 200 &&
          result.url === urls.success &&
          typeof result.content === "string"
          ? { content: `Alternative source returned: ${result.content}` }
          : {
              content: "No successful alternative-source result was observed.",
            };
      }
      if (content.includes('"error"')) {
        return { content: `Deterministic tool failed: ${content}` };
      }
      // Preserve the executed output in the fixture reply; journey assertions
      // independently require tool receipts and inspect downloaded Office bytes.
      if (
        /gate-|office_document/.test(content) ||
        textPrompt.includes("Inspect the uploaded Office fixture")
      ) {
        return { content: `Deterministic tool result: ${content}` };
      }
    }

    // 2. Post-tool execution synthesis
    if (isPostTool && toolMsg) {
      const toolContent =
        typeof toolMsg.content === "string" ? toolMsg.content : "";
      const toolName =
        toolMsg.name ??
        messages
          .slice()
          .reverse()
          .flatMap((message) => message.tool_calls ?? [])
          .find((toolCall) => toolCall.id === toolMsg.tool_call_id)?.function
          ?.name;

      if (toolContent.includes("31250")) {
        return { content: "The result of (12500 * 17.5) / 7 is 31250." };
      }
      if (toolContent.includes("65536")) {
        return {
          content: "RESULT: 65536\nThe calculation via Python produced 65536.",
        };
      }
      if (toolName === "search_chats") {
        const snippets = resultTexts(
          parseToolRecord(toolContent).results,
          "matchedSnippet"
        );
        return {
          content: snippets.length
            ? `Retrieved chat excerpts:\n${snippets.join("\n")}`
            : "No matching chat history was retrieved.",
        };
      }
      if (toolName === "memory_search") {
        const memories = resultTexts(
          parseToolRecord(toolContent).memories,
          "content"
        );
        return {
          content: memories.length
            ? `Retrieved preferences:\n${memories.join("\n")}`
            : "No saved preference was retrieved.",
        };
      }
      if (
        toolContent.includes("bun.sh") ||
        toolContent.includes("bun add") ||
        toolContent.includes("web_search") ||
        toolContent.includes("install package") ||
        toolContent.includes("Bun") ||
        toolName === "web_search" ||
        textPrompt.toLowerCase().includes("bun")
      ) {
        return {
          content:
            "According to the official Bun documentation [1], the command to install a package is `bun add <package>`.\n\n[1] Bun Documentation: https://bun.sh",
        };
      }
      if (
        toolName === "deep_research" ||
        toolContent.includes("deep_research") ||
        toolContent.includes("markdownReport") ||
        toolContent.includes("evidenceCount") ||
        toolContent.includes("HNSW") ||
        toolContent.includes("DiskANN") ||
        toolContent.includes("IVFPQ") ||
        toolContent.includes("agentic coding")
      ) {
        return {
          content:
            "# Research Report: Enterprise AI Coding Agents & Platforms\n\n## Architectural & Performance Comparison\n1. **OpenAI Codex / GPT-4o** [1]: High reasoning, broad API ecosystem.\n2. **Anthropic Claude 3.5 Sonnet** [2]: Strongest coding benchmarks, computer use.\n3. **Google Gemini 1.5 Pro** [3]: 2M token context window, deep multimodal.\n\n## References & Citations\n[1] OpenAI Documentation: https://openai.com\n[2] Anthropic Documentation: https://docs.anthropic.com\n[3] Google AI Documentation: https://ai.google.dev",
        };
      }
      if (
        toolContent.includes("Tokyo") ||
        toolContent.includes("Sunny") ||
        toolContent.includes("weather")
      ) {
        return {
          content:
            "According to the weather MCP server, the weather forecast for Tokyo is Sunny with 24°C and a mild breeze.",
        };
      }
      if (
        toolContent.includes("memory_write") ||
        toolContent.includes("Saved user memory") ||
        toolContent.includes("executive-friendly")
      ) {
        return {
          content:
            "I have saved your preference for concise, executive-friendly deliverables into durable memory.",
        };
      }
      if (
        toolContent.includes("pptx") ||
        toolContent.includes("atlas_overview") ||
        toolContent.includes("competitive_analysis")
      ) {
        return {
          content:
            "I have generated the presentation deck with executive summary, architecture comparison, and verified citations.",
        };
      }
      if (
        toolContent.includes("xlsx") ||
        toolContent.includes("financial_model") ||
        toolContent.includes("sales_report")
      ) {
        return {
          content:
            "Financial model generated successfully with scenario projections, formula calculations, and revenue breakdowns.",
        };
      }
      if (
        toolContent.includes("pricing.example.com") ||
        toolContent.includes("Enterprise Plan") ||
        toolContent.includes("SSO")
      ) {
        return {
          content:
            "Based on the pricing page, the **Enterprise Plan** includes SAML/SSO authentication, SIEM audit logs, and dedicated VPC support.",
        };
      }
      if (toolContent.includes("order") || textPrompt.includes("order")) {
        return {
          content:
            "Order successfully placed for Atlas Pro ($129.00). Confirmation #ORD-9821.",
        };
      }

      return {
        content: "Operation completed successfully. Deliverable generated.",
      };
    }

    // 3. Initial tool invocation / prompt matching
    const prompt = textPrompt.toLowerCase();

    if (
      prompt.includes("explain what a vector database is") ||
      prompt.includes("vector database")
    ) {
      return {
        content:
          "A **vector database** is a specialized database designed to store, index, and query high-dimensional vector embeddings. Unlike traditional relational databases that match exact keywords or scalar values, vector databases perform **approximate nearest neighbor (ANN)** search based on semantic distance metrics such as cosine similarity, dot product, or Euclidean distance.\n\nKey features include:\n- **High-Dimensional Indexing**: Uses algorithms like HNSW (Hierarchical Navigable Small World) or IVF-PQ to search millions of vectors in milliseconds.\n- **Semantic Retrieval**: Enables retrieval-augmented generation (RAG), recommendation engines, and multimodal similarity search.\n- **Metadata Filtering**: Allows combined scalar and vector filtering in a single query.",
      };
    }

    if (
      prompt.includes("deep research") ||
      prompt.includes("research three competitors") ||
      prompt.includes("agentic coding")
    ) {
      return {
        toolCalls: [
          {
            args: {
              depth: "comprehensive",
              focusAreas: [
                "pricing",
                "security",
                "integrations",
                "enterprise positioning",
              ],
              topic:
                "Competitor Analysis: Enterprise AI Coding Agents & Platforms",
            },
            name: "deep_research",
          },
        ],
      };
    }

    if (
      prompt.includes("search the web for the official bun") ||
      (prompt.includes("bun") &&
        (prompt.includes("install") ||
          prompt.includes("documentation") ||
          prompt.includes("package")))
    ) {
      return {
        content:
          "According to the official Bun documentation [1], the command to install a package is `bun add <package>`.\n\n[1] Bun Documentation: https://bun.sh",
      };
    }

    if (
      prompt.includes("board-ready") ||
      prompt.includes("8-slide presentation") ||
      prompt.includes("turn that research into")
    ) {
      return {
        toolCalls: [
          {
            args: {
              path: "competitive_analysis.pptx",
              revision: 1,
              slideCount: 8,
              title: "Enterprise AI Coding Agents: Competitive Landscape",
            },
            name: "write_pptx",
          },
        ],
      };
    }

    if (
      prompt.includes("make slide 4 more visual") ||
      prompt.includes("make slide 2 shorter") ||
      prompt.includes("make slide 2 simpler")
    ) {
      return {
        toolCalls: [
          {
            args: {
              parentPath: "atlas_overview.pptx",
              path: "atlas_overview_v2.pptx",
              revision: 2,
              title: "Competitive Analysis & Strategy Deck (v2)",
            },
            name: "write_pptx",
          },
        ],
      };
    }

    if (
      prompt.includes("create a 3-slide presentation") ||
      prompt.includes("presentation about atlas") ||
      prompt.includes("make a presentation")
    ) {
      return {
        toolCalls: [
          {
            args: {
              path: "atlas_overview.pptx",
              revision: 1,
              title: "Atlas Architecture & Overview",
            },
            name: "write_pptx",
          },
        ],
      };
    }

    if (
      prompt.includes("add a downside case") ||
      prompt.includes("downside case")
    ) {
      return {
        toolCalls: [
          {
            args: {
              action: "update",
              columns: ["Scenario", "Revenue", "EBITDA", "Cash Flow"],
              data: [
                ["Base Case", "$120,000", "$45,000", "$38,000"],
                ["Downside Case (-25%)", "$90,000", "$18,000", "$12,000"],
              ],
              parentPath: "financial_model.xlsx",
              path: "financial_model_v2.xlsx",
              revision: 2,
              sheetName: "Scenarios",
            },
            name: "spreadsheet",
          },
        ],
      };
    }

    if (prompt.includes("financial model") || prompt.includes("spreadsheet")) {
      return {
        toolCalls: [
          {
            args: {
              action: "create",
              columns: [
                "Period",
                "Revenue",
                "COGS",
                "Gross Profit",
                "Net Margin",
              ],
              data: [
                ["Q1", 100_000, 40_000, "=B2-C2", "=D2/B2"],
                ["Q2", 125_000, 48_000, "=B3-C3", "=D3/B3"],
                ["Q3", 160_000, 58_000, "=B4-C4", "=D4/B4"],
                ["Q4", 210_000, 72_000, "=B5-C5", "=D5/B5"],
              ],
              path: "financial_model.xlsx",
              sheetName: "Projections",
            },
            name: "spreadsheet",
          },
        ],
      };
    }

    if (
      prompt.includes("open the pricing page") ||
      prompt.includes("which plan has sso")
    ) {
      return {
        toolCalls: [
          {
            args: {
              action: "open",
              url: "https://pricing.example.com/plans",
            },
            name: "browser",
          },
        ],
      };
    }

    if (prompt.includes("delete the archived atlas export permanently")) {
      return {
        toolCalls: [
          {
            args: {
              path: "artifacts/archived-atlas-export.zip",
            },
            name: "delete_file",
          },
        ],
      };
    }

    if (
      prompt.includes("for future presentations") ||
      prompt.includes("keep them concise and executive-friendly") ||
      prompt.includes("remember that i prefer")
    ) {
      return {
        toolCalls: [
          {
            args: {
              content:
                "User prefers concise, executive-friendly deliverables with structured key points and clear business impact.",
              subject: "presentation_style",
            },
            name: "memory_write",
          },
        ],
      };
    }

    if (
      prompt.includes("how should you present technical explanations") ||
      prompt.includes("present technical explanations")
    ) {
      return {
        toolCalls: [
          { args: { query: "presentation_style" }, name: "memory_search" },
        ],
      };
    }

    if (
      prompt.includes("when did i say apollo launches") ||
      prompt.includes("apollo launch")
    ) {
      return {
        toolCalls: [
          {
            args: { query: "Apollo launch date" },
            name: "search_chats",
          },
        ],
      };
    }

    if (prompt.includes("broken-source")) {
      return {
        content: "No deterministic recovery fixture was provided.",
      };
    }

    if (prompt.includes("calculate") || prompt.includes("calculator")) {
      return {
        toolCalls: [
          {
            args: { expression: "(12500 * 17.5) / 7" },
            name: "calculator",
          },
        ],
      };
    }

    if (prompt.includes("create a file") || prompt.includes("e2e-test.txt")) {
      return {
        toolCalls: [
          {
            args: { content: "hello atlas", path: "e2e-test.txt" },
            name: "write_file",
          },
        ],
      };
    }

    if (prompt.includes("2 + 2") || prompt.includes("what is 2 + 2")) {
      return { content: "4" };
    }

    if (
      prompt.includes("research our competitors") &&
      prompt.includes("spreadsheet")
    ) {
      return {
        content:
          "Competitor scan complete. Saved competitive_analysis.pptx and financial_model.xlsx with pricing, security, and enterprise notes.",
      };
    }

    if (prompt.includes("update the deck") && prompt.includes("appendix")) {
      return {
        content:
          "Updated the deck with the pricing changes and added source links to the appendix.",
      };
    }

    return {
      content: "Hello! I am your Atlas agent. How can I help you today?",
    };
  }

  private buildSseStreamResponse(result: MockResponseResult): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        if (result.toolCalls && result.toolCalls.length > 0) {
          const chunk1 = {
            choices: [
              {
                delta: {
                  role: "assistant",
                  tool_calls: result.toolCalls.map((tc, idx) => ({
                    function: {
                      arguments: JSON.stringify(tc.args),
                      name: tc.name,
                    },
                    id: tc.id ?? `call_${Date.now()}_${idx}`,
                    index: idx,
                    type: "function",
                  })),
                },
                finish_reason: null,
                index: 0,
              },
            ],
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk1)}\n\n`)
          );

          const chunk2 = {
            choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk2)}\n\n`)
          );
        } else {
          const chunk1 = {
            choices: [
              {
                delta: { content: result.content ?? "", role: "assistant" },
                finish_reason: null,
                index: 0,
              },
            ],
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk1)}\n\n`)
          );

          const chunk2 = {
            choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk2)}\n\n`)
          );
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      },
    });
  }

  private buildJsonResponse(result: MockResponseResult): Response {
    return new Response(
      JSON.stringify({
        choices: [
          result.toolCalls && result.toolCalls.length > 0
            ? {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: result.toolCalls.map((tc, idx) => ({
                    function: {
                      arguments: JSON.stringify(tc.args),
                      name: tc.name,
                    },
                    id: tc.id ?? `call_${Date.now()}_${idx}`,
                    type: "function",
                  })),
                },
              }
            : {
                finish_reason: "stop",
                message: { content: result.content ?? "", role: "assistant" },
              },
        ],
        id: "chatcmpl-mock",
        object: "chat.completion",
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
}
