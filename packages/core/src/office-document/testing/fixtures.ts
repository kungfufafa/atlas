import {
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import pptxgen from "pptxgenjs";

export const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAARP+ljAAABC0lEQVR4nO3dsQkCQRBA0T2xKBMbsA9zwToEc/uwARObMTExtQbhDrnPewUMC5+JJtjp9f4Mujb/fgDLEjhO4DiB4wSOEzhO4DiB4wSO2/77Aauxu19nn/k8nMbCbHCcwHECxwkcJ3CcwHECxwkcJ3CcwHECxwkct6Zjw/H8mH3m7bIfaTY4TuA4geMEjhM4TuA4geMEjhM4TuA4geMEjhM4TuC4386FDnarY4PjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOG7yA3ibDY4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBB5tXzl0D1Eyc5XJAAAAAElFTkSuQmCC",
  "base64"
);

export async function createWordFixture(): Promise<Buffer> {
  return Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({
              children: [
                new TextRun({ bold: true, text: "Hello " }),
                new TextRun({ italics: true, text: "Atlas" }),
              ],
            }),
            new Paragraph({
              children: [
                new ExternalHyperlink({
                  children: [new TextRun("Atlas website")],
                  link: "https://example.com/atlas",
                }),
              ],
            }),
            new Table({
              columnWidths: [4500, 4500],
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Product")] }),
                    new TableCell({ children: [new Paragraph("Status")] }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Atlas")] }),
                    new TableCell({ children: [new Paragraph("Draft")] }),
                  ],
                }),
              ],
              width: { size: 100, type: WidthType.PERCENTAGE },
            }),
            new Paragraph({
              children: [
                new ImageRun({
                  data: FIXTURE_PNG,
                  transformation: { height: 48, width: 96 },
                  type: "png",
                }),
              ],
            }),
          ],
          footers: {
            default: new Footer({
              children: [new Paragraph("Confidential footer")],
            }),
          },
          headers: {
            default: new Header({
              children: [new Paragraph("Quarterly review header")],
            }),
          },
        },
      ],
    })
  );
}

export async function createPresentationFixture(): Promise<Buffer> {
  const presentation = new pptxgen();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "Atlas office verification";
  const first = presentation.addSlide();
  first.addText(
    [
      { options: { bold: true }, text: "Hello " },
      { options: { italic: true }, text: "Atlas" },
    ],
    { fontSize: 28, h: 0.7, w: 10, x: 0.5, y: 0.4 }
  );
  first.addTable(
    [
      ["Product", "Status"],
      ["Atlas", "Draft"],
    ],
    { fontSize: 18, h: 2, w: 7, x: 0.5, y: 1.5 }
  );
  first.addImage({
    data: `image/png;base64,${FIXTURE_PNG.toString("base64")}`,
    h: 0.5,
    w: 1,
    x: 10,
    y: 0.5,
  });
  first.addNotes("Speaker note: confirm results.");
  const second = presentation.addSlide();
  second.addText("Second slide", { fontSize: 28, h: 1, w: 10, x: 0.5, y: 0.5 });
  second.addNotes("Second speaker note.");
  const output = await presentation.write({ outputType: "nodebuffer" });
  if (!(output instanceof Uint8Array)) {
    throw new Error("Expected a presentation buffer.");
  }
  return Buffer.from(output);
}
