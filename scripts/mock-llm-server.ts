import { serve } from "bun";

const server = serve({
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/v1/models" && req.method === "GET") {
      return new Response(
        JSON.stringify({
          data: [{ id: "mock-model", object: "model", owned_by: "local" }],
          object: "list",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = (await req.json()) as {
        messages: Array<{
          content?: string;
          name?: string;
          role: string;
          tool_call_id?: string;
        }>;
        stream?: boolean;
      };

      const messages = body.messages || [];
      const lastMsg = messages[messages.length - 1];

      // Check if this is a follow-up after tool execution
      const toolMsg = messages
        .slice()
        .reverse()
        .find((m) => m.role === "tool");
      const isPostTool = lastMsg?.role === "tool";

      let responseContent = "";
      let toolCall: { name: string; args: Record<string, unknown> } | null =
        null;

      if (isPostTool && toolMsg) {
        const content = toolMsg.content || "";
        if (content.includes("31250")) {
          responseContent = "The result of (12500 * 17.5) / 7 is 31250.";
        } else if (content.includes("65536")) {
          responseContent =
            "RESULT: 65536\nThe calculation via Python produced 65536.";
        } else if (
          content.includes("bun.sh") ||
          content.includes("bun add") ||
          content.includes("web_search") ||
          content.includes("install package")
        ) {
          responseContent =
            "According to the official Bun documentation [1], the command to install a package is `bun add <package>`.";
        } else if (
          content.includes("deep_research") ||
          content.includes("HNSW") ||
          content.includes("DiskANN") ||
          content.includes("IVFPQ") ||
          content.includes("agentic coding")
        ) {
          responseContent =
            "# Research Report: Agentic Coding Platforms & Models\n\n## Architectural & Performance Comparison\n1. **OpenAI Codex / GPT-4o** [1]: High reasoning, broad API ecosystem, function calling.\n2. **Anthropic Claude 3.5 Sonnet** [2]: Strongest coding benchmarks, computer use capability.\n3. **Google Gemini 1.5 Pro** [3]: 2M token context window, deep multimodal understanding.\n\n## References & Citations\n[1] OpenAI Documentation: https://openai.com\n[2] Anthropic Documentation: https://docs.anthropic.com\n[3] Google AI Documentation: https://ai.google.dev";
        } else if (
          content.includes("weather") ||
          content.includes("Tokyo") ||
          content.includes("Sunny") ||
          content.includes("24°C")
        ) {
          responseContent =
            "According to the weather MCP server, the weather forecast for Tokyo is Sunny with 24°C and a mild breeze.";
        } else if (
          content.includes("search_chats") ||
          content.includes("Titan") ||
          content.includes("Apollo") ||
          content.includes("October 12") ||
          content.includes("November 15")
        ) {
          if (
            content.includes("Apollo") ||
            lastMsg?.content?.includes("Apollo")
          ) {
            responseContent =
              "Based on our past discussions in previous chats, the Apollo launch is scheduled for October 12.";
          } else {
            responseContent =
              "Based on our past discussions in previous chats, the launch date for project Titan is November 15.";
          }
        } else if (
          content.includes("mcp__github") ||
          content.includes("github") ||
          content.includes("issues")
        ) {
          responseContent =
            "Found 2 open GitHub issues related to Atlas: #42 (Streaming latency optimization) and #88 (Source citations panel).";
        } else if (
          content.includes("memory_write") ||
          content.includes("Saved user memory") ||
          content.includes("explanation_style") ||
          content.includes("concise")
        ) {
          responseContent =
            "I have saved your preference for concise technical answers into durable memory.";
        } else if (
          content.includes("atlas_overview.pptx") ||
          content.includes("pptx") ||
          content.includes("slide")
        ) {
          responseContent =
            "I have created the presentation 'atlas_overview.pptx' covering Atlas Architecture, Tool Platform, and Research Capability.";
        } else if (
          content.includes("sales_report.xlsx") ||
          content.includes("xlsx") ||
          content.includes("revenue")
        ) {
          responseContent =
            "Sales Analysis Complete: Total revenue reached $70 with a strong upward trend across Apple and Banana categories.";
        } else if (
          content.includes("browser") ||
          content.includes("Atlas Test Store") ||
          content.includes("Product Catalog") ||
          content.includes("Search Results") ||
          content.includes("Atlas Pro") ||
          content.includes("order") ||
          content.includes("$129") ||
          content.includes("$299")
        ) {
          if (
            content.includes("order") ||
            lastMsg?.content?.includes("order")
          ) {
            responseContent =
              "Order successfully placed for Atlas Pro ($129.00). Confirmation #ORD-9821.";
          } else {
            responseContent =
              "I navigated the test shop and found Atlas Pro listed at $129.00.";
          }
        } else {
          responseContent =
            "Operation completed successfully. Deliverable generated.";
        }
      } else {
        const prompt =
          typeof lastMsg?.content === "string" ? lastMsg.content : "";
        if (
          prompt.includes("deep research") ||
          prompt.includes("agentic coding") ||
          prompt.includes("vector database indexing algorithms") ||
          prompt.includes("HNSW vs IVFPQ")
        ) {
          toolCall = {
            args: {
              depth: "comprehensive",
              focusAreas: ["latency", "recall", "memory footprint"],
              topic: "Agentic coding platforms (OpenAI vs Anthropic vs Gemini)",
            },
            name: "deep_research",
          };
        } else if (
          prompt.includes("pricing comparison") ||
          prompt.includes("Add pricing")
        ) {
          toolCall = {
            args: {
              depth: "standard",
              focusAreas: ["pricing", "tokens per dollar"],
              topic: "Pricing comparison for agentic coding models",
            },
            name: "deep_research",
          };
        } else if (
          prompt.includes("GitHub issues") ||
          prompt.includes("github issues") ||
          prompt.includes("open issues")
        ) {
          toolCall = {
            args: { query: "is:open repo:atlas" },
            name: "mcp__github__search_issues",
          };
        } else if (
          prompt.includes("Apollo launch") ||
          prompt.includes("Apollo launches") ||
          prompt.includes("Apollo")
        ) {
          toolCall = {
            args: { query: "Apollo launch date" },
            name: "search_chats",
          };
        } else if (
          prompt.includes("Place the order") ||
          prompt.includes("submit order")
        ) {
          toolCall = {
            args: {
              action: "submit_order",
              amount: "$129.00",
              item: "Atlas Pro",
            },
            name: "browser",
          };
        } else if (
          prompt.includes("Open the test shop") ||
          prompt.includes("find Atlas Pro")
        ) {
          toolCall = {
            args: {
              action: "open",
              url: "https://shop.example.com/products/atlas-pro",
            },
            name: "browser",
          };
        } else if (
          prompt.includes("sales_report.xlsx") ||
          prompt.includes("Analyze revenue")
        ) {
          toolCall = {
            args: {
              action: "inspect",
              filename: "sales_report.xlsx",
            },
            name: "spreadsheet",
          };
        } else if (
          prompt.includes("Make slide 2 simpler") ||
          prompt.includes("slide 2")
        ) {
          toolCall = {
            args: {
              parentPath: "atlas_overview.pptx",
              path: "atlas_overview_v2.pptx",
              revision: 2,
              title: "Atlas Overview v2",
            },
            name: "write_pptx",
          };
        } else if (
          prompt.includes("presentation") ||
          prompt.includes("make a presentation")
        ) {
          toolCall = {
            args: {
              path: "atlas_overview.pptx",
              revision: 1,
              title: "Atlas Overview",
            },
            name: "write_pptx",
          };
        } else if (
          prompt.includes("Remember that I prefer") ||
          prompt.includes("concise technical")
        ) {
          toolCall = {
            args: {
              content: "User prefers concise technical answers.",
              subject: "explanation_style",
            },
            name: "memory_write",
          };
        } else if (
          prompt.includes("Bun") ||
          prompt.includes("install package") ||
          prompt.includes("latest release command")
        ) {
          toolCall = {
            args: {
              query: "official Bun documentation install package command",
            },
            name: "web_search",
          };
        } else if (prompt.includes("broken-source")) {
          responseContent =
            "I couldn't reach one source, so I continued with the others.";
        } else if (
          prompt.includes("weather forecast") ||
          prompt.includes("weather MCP") ||
          prompt.includes("forecast for Tokyo")
        ) {
          toolCall = {
            args: {
              city: "Tokyo",
            },
            name: "weather__get_forecast",
          };
        } else if (
          prompt.includes("decided project Titan") ||
          prompt.includes("Titan launch date is")
        ) {
          responseContent =
            "Noted! I have recorded that project Titan's launch date is set for November 15.";
        } else if (
          prompt.includes("When is the project Titan launch date") ||
          prompt.includes("past discussions")
        ) {
          toolCall = {
            args: {
              query: "Titan launch date",
            },
            name: "search_chats",
          };
        } else if (
          prompt.includes("Remember that I prefer") ||
          prompt.includes("prefer technical answers")
        ) {
          toolCall = {
            args: {
              content: "User prefers technical answers with concise examples.",
              importance: 4,
              scope: "user",
              subject: "explanation_style",
            },
            name: "memory_write",
          };
        } else if (
          prompt.includes("present technical explanations") ||
          prompt.includes("How should you present")
        ) {
          responseContent =
            "Based on your saved preferences, I will present technical explanations with concise examples and direct technical depth.";
        } else if (
          prompt.includes("presentation") ||
          prompt.includes("3-slide") ||
          prompt.includes("slide deck")
        ) {
          toolCall = {
            args: {
              path: "atlas_overview.pptx",
              slides: [
                {
                  layout: "title",
                  subtitle: "Autonomous Agent Capability Platform",
                  title: "Atlas Architecture",
                },
                {
                  bulletPoints: [
                    "Web search and fetch primitives",
                    "Interactive browser tool",
                    "Rich artifact engine",
                  ],
                  title: "Tool Platform",
                },
                {
                  bulletPoints: [
                    "Multi-source evidence extraction",
                    "Contradiction detection",
                    "Inline verified citations",
                  ],
                  title: "Research Capability",
                },
              ],
              title: "Atlas Overview",
            },
            name: "write_pptx",
          };
        } else if (
          prompt.includes("Open the test store") ||
          prompt.includes("test store") ||
          prompt.includes("Atlas Pro")
        ) {
          toolCall = {
            args: {
              action: "open",
              url: "http://127.0.0.1:8089/",
            },
            name: "browser",
          };
        } else if (
          prompt.includes("Search the web") ||
          prompt.includes("Bun documentation") ||
          prompt.includes("install a package")
        ) {
          toolCall = {
            args: {
              domains: ["bun.sh"],
              query: "official Bun documentation install package command",
            },
            name: "web_search",
          };
        } else if (
          prompt.includes("Calculate") ||
          prompt.includes("calculator")
        ) {
          toolCall = {
            args: { expression: "(12500 * 17.5) / 7" },
            name: "calculator",
          };
        } else if (
          prompt.includes("e2e-test.txt") ||
          prompt.includes("Create a file")
        ) {
          toolCall = {
            args: { content: "hello atlas", path: "e2e-test.txt" },
            name: "write_file",
          };
        } else if (
          prompt.includes("python_execute") ||
          prompt.includes("2**16")
        ) {
          toolCall = {
            args: { code: "print(2**16)" },
            name: "python_execute",
          };
        } else if (
          prompt.includes("spreadsheet") ||
          prompt.includes("sales_report.xlsx")
        ) {
          toolCall = {
            args: {
              action: "create",
              columns: ["Item", "Qty", "Price", "Total"],
              data: [
                ["Apples", 10, 3, "=B2*C2"],
                ["Bananas", 20, 2, "=B3*C3"],
              ],
              path: "sales_report.xlsx",
              sheetName: "Sales",
            },
            name: "spreadsheet",
          };
        } else if (
          prompt.includes("tool_search") ||
          prompt.includes("Find tools")
        ) {
          toolCall = {
            args: { activate: true, query: "spreadsheet" },
            name: "tool_search",
          };
        } else if (
          prompt.includes("title") ||
          prompt.includes("summarize this chat")
        ) {
          responseContent = "E2E Conversation Session";
        } else {
          responseContent =
            "Hello! I am your Atlas agent. How can I help you today?";
        }
      }

      if (body.stream) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            if (toolCall) {
              const chunk1 = {
                choices: [
                  {
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          function: {
                            arguments: JSON.stringify(toolCall.args),
                            name: toolCall.name,
                          },
                          id: `call_${Date.now()}`,
                          index: 0,
                          type: "function",
                        },
                      ],
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
                    delta: { content: responseContent, role: "assistant" },
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

      return new Response(
        JSON.stringify({
          choices: [
            toolCall
              ? {
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    tool_calls: [
                      {
                        function: {
                          arguments: JSON.stringify(toolCall.args),
                          name: toolCall.name,
                        },
                        id: `call_${Date.now()}`,
                        type: "function",
                      },
                    ],
                  },
                }
              : {
                  finish_reason: "stop",
                  message: { content: responseContent, role: "assistant" },
                },
          ],
          id: "chatcmpl-mock",
          object: "chat.completion",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
  port: 11_435,
});

console.log(`Mock LLM server running on http://127.0.0.1:${server.port}`);
