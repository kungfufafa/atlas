import type { IParagraphOptions, IRunOptions, ParagraphChild } from "docx";
import type { Token, Tokens } from "marked";
import {
  type MarkdownDocxOptions,
  resolveDocxImages,
} from "./docx-write-images";

/**
 * Build a real `.docx` (a ZIP of OOXML parts) from Markdown.
 *
 * `write_file` can only emit UTF-8 text, so an agent asked for a Word document has
 * no honest way to produce one — it ends up saving HTML or bare WordprocessingML
 * under a `.docx` name, which Word then displays as raw stylesheet source. This is
 * the tool that closes that gap.
 */
export async function markdownToDocx(
  markdown: string,
  options: MarkdownDocxOptions = {}
): Promise<Buffer> {
  const {
    Document,
    Packer,
    Paragraph,
    HeadingLevel,
    TextRun,
    ExternalHyperlink,
    ImageRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
  } = await import("docx");
  const { marked } = await import("marked");
  const tokens = marked.lexer(markdown);
  const references = new Set<string>();
  marked.walkTokens(tokens, (token) => {
    if (token.type === "image") {
      references.add((token as Tokens.Image).href);
    }
  });
  const images = await resolveDocxImages(references, options);

  const HEADING_BY_DEPTH = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];

  /** Convert inline Markdown into styled runs, real links, and embedded images. */
  function toRuns(
    tokens: Token[] | undefined,
    inherited: Partial<IRunOptions> = {}
  ): ParagraphChild[] {
    const runs: ParagraphChild[] = [];

    for (const token of tokens ?? []) {
      switch (token.type) {
        case "strong":
          runs.push(
            ...toRuns((token as Tokens.Strong).tokens, {
              ...inherited,
              bold: true,
            })
          );
          break;
        case "em":
          runs.push(
            ...toRuns((token as Tokens.Em).tokens, {
              ...inherited,
              italics: true,
            })
          );
          break;
        case "del":
          runs.push(
            ...toRuns((token as Tokens.Del).tokens, {
              ...inherited,
              strike: true,
            })
          );
          break;
        case "link": {
          const link = token as Tokens.Link;
          if (!/^(https?:|mailto:)/i.test(link.href)) {
            throw new Error(
              "Word hyperlinks support http, https, and mailto destinations."
            );
          }
          runs.push(
            new ExternalHyperlink({
              children: toRuns(link.tokens, {
                ...inherited,
                style: "Hyperlink",
              }),
              link: link.href,
            })
          );
          break;
        }
        case "image": {
          const image = token as Tokens.Image;
          const resolved = images.get(image.href);
          if (!resolved) {
            throw new Error("Markdown image was not resolved.");
          }
          runs.push(
            new ImageRun({
              ...resolved,
              altText: {
                description: image.text,
                name: image.text,
                title: image.title ?? image.text,
              },
            })
          );
          break;
        }
        case "codespan":
          runs.push(
            new TextRun({
              ...inherited,
              font: "Courier New",
              text: (token as Tokens.Codespan).text,
            })
          );
          break;
        case "br":
          runs.push(new TextRun({ ...inherited, break: 1, text: "" }));
          break;
        default: {
          if ("tokens" in token && Array.isArray(token.tokens)) {
            runs.push(...toRuns(token.tokens, inherited));
            break;
          }
          const text =
            "text" in token
              ? String((token as { text: unknown }).text ?? "")
              : "";
          if (text) {
            runs.push(new TextRun({ ...inherited, text }));
          }
        }
      }
    }

    return runs;
  }

  function paragraph(
    tokens: Token[] | undefined,
    options: IParagraphOptions = {}
  ) {
    const children = toRuns(tokens);
    return new Paragraph({
      ...options,
      children: children.length > 0 ? children : undefined,
    });
  }

  function tableCell(cell: Tokens.TableCell, header: boolean) {
    return new TableCell({
      children: [
        new Paragraph({
          children: toRuns(cell.tokens, { bold: header }),
          keepNext: header,
          spacing: { after: 0, before: 0 },
        }),
      ],
      margins: { bottom: 120, left: 140, right: 140, top: 120 },
    });
  }

  function blocksFrom(
    tokens: Token[]
  ): Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> {
    const blocks: Array<
      InstanceType<typeof Paragraph> | InstanceType<typeof Table>
    > = [];

    for (const token of tokens) {
      switch (token.type) {
        case "heading": {
          const heading = token as Tokens.Heading;
          blocks.push(
            paragraph(heading.tokens, {
              heading: HEADING_BY_DEPTH[Math.min(heading.depth, 6) - 1],
            })
          );
          break;
        }
        case "paragraph":
          blocks.push(paragraph((token as Tokens.Paragraph).tokens));
          break;
        case "blockquote":
          blocks.push(
            ...blocksFrom((token as Tokens.Blockquote).tokens).map((block) =>
              block instanceof Paragraph ? block : block
            )
          );
          break;
        case "list": {
          const list = token as Tokens.List;
          list.items.forEach((item) => {
            blocks.push(
              paragraph(item.tokens, {
                bullet: list.ordered ? undefined : { level: 0 },
                numbering: list.ordered
                  ? { level: 0, reference: "ordered" }
                  : undefined,
              })
            );
          });
          break;
        }
        case "table": {
          const table = token as Tokens.Table;
          const border = {
            color: "D1D5DB",
            size: 4,
            style: BorderStyle.SINGLE,
          };
          blocks.push(
            new Table({
              borders: {
                bottom: border,
                insideHorizontal: border,
                insideVertical: border,
                left: border,
                right: border,
                top: border,
              },
              columnWidths: table.header.map(() =>
                Math.floor(9000 / Math.max(1, table.header.length))
              ),
              rows: [
                new TableRow({
                  cantSplit: true,
                  children: table.header.map((cell) => tableCell(cell, true)),
                  tableHeader: true,
                }),
                ...table.rows.map(
                  (row) =>
                    new TableRow({
                      cantSplit: true,
                      children: row.map((cell) => tableCell(cell, false)),
                    })
                ),
              ],
              width: { size: 100, type: WidthType.PERCENTAGE },
            })
          );
          break;
        }
        case "code":
          for (const line of (token as Tokens.Code).text.split("\n")) {
            blocks.push(
              new Paragraph({
                children: [new TextRun({ font: "Courier New", text: line })],
              })
            );
          }
          break;
        case "hr":
          blocks.push(
            new Paragraph({
              border: { bottom: { size: 6, style: "single" } },
              text: "",
            })
          );
          break;
        default:
          break;
      }
    }

    return blocks;
  }

  const blocks = blocksFrom(tokens);

  const document = new Document({
    numbering: {
      config: [
        {
          levels: [
            { alignment: "start", format: "decimal", level: 0, text: "%1." },
          ],
          reference: "ordered",
        },
      ],
    },
    sections: [
      {
        children: blocks.length > 0 ? blocks : [new Paragraph({ text: "" })],
      },
    ],
    styles: {
      default: {
        document: {
          paragraph: { spacing: { after: 120 } },
          run: { color: "000000", font: "Arial", size: 22 },
        },
        heading1: {
          paragraph: { keepNext: true, spacing: { after: 120, before: 240 } },
          run: { bold: true, color: "000000", size: 32 },
        },
        heading2: {
          paragraph: { keepNext: true },
          run: { bold: true, color: "000000", size: 28 },
        },
        heading3: {
          paragraph: { keepNext: true },
          run: { bold: true, color: "000000", size: 24 },
        },
        heading4: {
          paragraph: { keepNext: true },
          run: { bold: true, color: "000000", size: 22 },
        },
        heading5: {
          paragraph: { keepNext: true },
          run: { bold: true, color: "000000", size: 22 },
        },
        heading6: {
          paragraph: { keepNext: true },
          run: { bold: true, color: "000000", size: 22 },
        },
      },
    },
  });

  return Packer.toBuffer(document);
}
