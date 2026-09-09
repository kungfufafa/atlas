"""Independent synthetic fixtures for the predeclared daily-files corpus."""
import argparse
import csv
import hashlib
import json
import shutil
from datetime import datetime
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches as WordInches
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.comments import Comment
from openpyxl.formatting.rule import ColorScaleRule
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableColumn, TableStyleInfo
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(root, font_path):
    root.mkdir(parents=True, exist_ok=True)
    if (root / "manifest.json").exists():
        raise ValueError("The fixture manifest already exists; use a new root to preserve recorded source hashes.")
    cases = []
    chart = root / "chart.png"
    image = Image.new("RGB", (400, 160), "white")
    draw = ImageDraw.Draw(image)
    for x, y, color in [(40, 90, "#3465a4"), (140, 55, "#3465a4"), (240, 20, "#2ca078")]:
        draw.rectangle((x, y, x + 65, 145), fill=color)
    image.save(chart)
    pdfmetrics.registerFont(TTFont("CorpusUnicode", str(font_path)))

    def case(case_id, **expectations):
        folder = root / "inputs" / case_id
        folder.mkdir(parents=True, exist_ok=True)
        entry = {"id": case_id, "directory": str(folder), "expected": expectations}
        cases.append(entry)
        return folder, entry

    def word_base():
        document = Document()
        document.sections[0].header.paragraphs[0].text = "Synthetic review · 2026"
        document.sections[0].footer.paragraphs[0].text = "Original footer"
        return document

    folder, entry = case("D01", allowedParts=["word/document.xml"], text="Résumé validé — 東京 مرحبا")
    document = word_base()
    paragraph = document.add_paragraph()
    paragraph.add_run("Résumé ").bold = True
    paragraph.add_run("en ").italic = True
    paragraph.add_run("attente — 東京 مرحبا").underline = True
    link_p = document.add_paragraph("Reference: ")
    hyperlink = OxmlElement("w:hyperlink")
    relationship = link_p.part.relate_to("https://example.invalid/reference", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
    hyperlink.set(qn("r:id"), relationship)
    run = OxmlElement("w:r"); text = OxmlElement("w:t"); text.text = "Reference page"; run.append(text); hyperlink.append(run); link_p._p.append(hyperlink)
    document.add_paragraph("First item", style="List Number")
    document.add_picture(str(chart), width=WordInches(2.5))
    document.save(folder / "input.docx")

    folder, entry = case("D02", allowedParts=["word/document.xml"], text="Inner approved")
    document = word_base(); document.add_paragraph("Nested approval register")
    outer = document.add_table(rows=2, cols=2); outer.style = "Table Grid"
    outer.cell(0, 0).text = "Outer header"; outer.cell(0, 1).text = "Unchanged"
    outer.cell(1, 0).text = "Outer keeper"
    inner = outer.cell(1, 1).add_table(rows=2, cols=2); inner.style = "Table Grid"
    for row, values in zip(inner.rows, [["Item", "State"], ["Nested", "Inner draft"]]):
        for cell, value in zip(row.cells, values): cell.text = value
    document.save(folder / "input.docx")

    folder, entry = case("D03", allowedParts=["word/document.xml"], text="Inserted approved")
    document = word_base(); paragraph = document.add_paragraph("Inserted draft")
    insertion = OxmlElement("w:ins"); insertion.set(qn("w:id"), "4"); insertion.set(qn("w:author"), "Synthetic reviewer")
    paragraph._p.addprevious(insertion); insertion.append(paragraph._p)
    document.save(folder / "input.docx")

    folder, entry = case("D04", allowedParts=["word/header2.xml"], text="Second section approved")
    document = word_base(); document.sections[0].header.paragraphs[0].text = "First section keep"
    document.add_paragraph("First section body")
    second = document.add_section(WD_SECTION_START.NEW_PAGE); second.header.is_linked_to_previous = False
    second.header.paragraphs[0].text = "Second section draft"; document.add_paragraph("Second section body")
    document.save(folder / "input.docx")

    def slide_base():
        presentation = Presentation(); presentation.slide_width = Inches(13.333); presentation.slide_height = Inches(7.5)
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        slide.notes_slide.notes_text_frame.text = "Notes remain intact."
        return presentation, slide

    def textbox(slide, text, x=0.5, y=0.3):
        shape = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(11.5), Inches(0.8))
        shape.text_frame.paragraphs[0].text = text
        shape.text_frame.paragraphs[0].font.size = Pt(24)
        return shape

    folder, entry = case("P01", allowedParts=["ppt/slides/slide1.xml"], text="Quarter approved")
    presentation, slide = slide_base(); textbox(slide, "Quarter draft")
    data = CategoryChartData(); data.categories = ["Alpha", "Beta", "Gamma"]; data.add_series("Units", [12, 8, 15])
    slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.8), Inches(1.4), Inches(8), Inches(4.5), data)
    presentation.save(folder / "input.pptx")

    folder, entry = case("P02", allowedParts=["ppt/slides/slide1.xml"], text="Grouped approved")
    presentation, slide = slide_base(); textbox(slide, "Grouped report")
    group = slide.shapes.add_group_shape()
    group.shapes.add_textbox(Inches(1), Inches(2), Inches(4), Inches(1)).text = "Grouped draft"
    group.shapes.add_textbox(Inches(6), Inches(2), Inches(4), Inches(1)).text = "Grouped keeper"
    slide.shapes.add_picture(str(chart), Inches(1), Inches(4), width=Inches(4))
    presentation.save(folder / "input.pptx")

    folder, entry = case("P03", allowedParts=["ppt/slides/slide1.xml"], text="Merged approved")
    presentation, slide = slide_base(); textbox(slide, "Merged-cell register")
    table = slide.shapes.add_table(2, 3, Inches(1), Inches(2), Inches(10), Inches(2)).table
    table.cell(0, 0).merge(table.cell(0, 1)); table.cell(0, 0).text = "Merged draft"; table.cell(0, 2).text = "Keeper"
    presentation.save(folder / "input.pptx")

    folder, entry = case("P04", allowedParts=["ppt/slides/slide1.xml"], text="تمت المراجعة — 東京 café")
    presentation, slide = slide_base(); shape = textbox(slide, "قيد المراجعة — 東京 café")
    shape.text_frame.paragraphs[0]._p.get_or_add_pPr().set("rtl", "1")
    shape.text_frame.paragraphs[0].font.name = "Arial Unicode MS"
    presentation.slides.add_slide(presentation.slide_layouts[6]); presentation.save(folder / "input.pptx")

    folder, entry = case("X01")
    workbook = Workbook(); sheet = workbook.active; sheet.title = "Records"
    sheet.append(["ID", "Date", "Units", "State"]); sheet.append(["000042", datetime(2026,9,6), 7, "Draft"])
    sheet["B2"].number_format = "yyyy-mm-dd"; sheet["C2"].number_format = "0.00"; sheet["A2"].comment = Comment("Keep this identifier", "Synthetic")
    sheet["D2"].hyperlink = "https://example.invalid/state"; sheet.freeze_panes = "B2"
    validation = DataValidation(type="list", formula1='"Draft,Approved"'); sheet.add_data_validation(validation); validation.add("D2:D20")
    hidden = workbook.create_sheet("Lookup"); hidden.append(["Keep", 99]); hidden.sheet_state = "hidden"
    workbook.save(folder / "input.xlsx")

    folder, entry = case("X02", total=19, decision="Review", date="2026-09-06")
    workbook = Workbook(); data = workbook.active; data.title = "Data"
    for row in [["Region","Date","Units"],["North",datetime(2026,9,6),7],["South",datetime(2026,9,7),12],["North",datetime(2026,9,8),8]]: data.append(row)
    summary = workbook.create_sheet("Summary"); summary["A1"] = "Independent summary"; summary["B2"] = '=SUMIFS(Data!C2:C4,Data!A2:A4,"North")'; summary["B3"] = '=IF(B2>=20,"Ready","Review")'; summary["B4"] = '=DATE(2026,9,6)'; summary["B4"].number_format = "yyyy-mm-dd"
    workbook.save(folder / "input.xlsx")

    folder, entry = case("X03")
    workbook = Workbook(); sheet = workbook.active; sheet.title = "Chart data"; sheet.append(["Item","Units"]); sheet.append(["Alpha",4]); sheet.append(["Beta",5])
    native = BarChart(); native.add_data(Reference(sheet,min_col=2,min_row=1,max_row=3),titles_from_data=True); sheet.add_chart(native,"E2"); workbook.save(folder / "input.xlsx")

    folder, entry = case("X04", total=17)
    workbook = Workbook(); sheet = workbook.active; sheet.title = "Table data"
    for row in [["ID","Qty"],["0001",4],["0002",5],["Total",'=SUBTOTAL(109,TasksTable[Qty])']]: sheet.append(row)
    table = Table(displayName="TasksTable",ref="A1:B4",totalsRowCount=1,tableColumns=[TableColumn(id=1,name="ID",totalsRowLabel="Total"),TableColumn(id=2,name="Qty",totalsRowFunction="sum")]); table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2",showRowStripes=True); sheet.add_table(table)
    sheet.conditional_formatting.add("B2:B3",ColorScaleRule(start_type="min",start_color="F8696B",end_type="max",end_color="63BE7B")); workbook.save(folder / "input.xlsx")

    csv_cases = {
        "C01": (";", [["ID","Long ID","Description","Code"],["00012","12345678901234567890","café; 東京\nsecond line","=SUM(A1:A2)"],["00013","00000000000000000009",'He said "ready"',"-0042"]]),
        "C02": (";", [["ID","Amount"],["00012","12,50"],["00013","-0,75"]]),
        "C03": ("\t", [["ID","Description","Expression","Trailing"],["001","a\tb\nnext","@SUM(A1)",""],["002",'"quoted"',"+0012",""]]),
    }
    for case_id,(delimiter,rows) in csv_cases.items():
        folder, entry = case(case_id,delimiter=delimiter,rows=rows)
        with (folder/"input.csv").open("w",encoding="utf-8-sig" if case_id == "C01" else "utf-8",newline="") as handle: csv.writer(handle,delimiter=delimiter,lineterminator="\r\n").writerows(rows)

    folder, entry = case("F01", pages=[3,2], texts=["Page three café naïve", "Rotated beta table"])
    raw = folder/"unrotated.pdf"; pdf = canvas.Canvas(str(raw))
    for text_value in ["Page one keep","Rotated beta table","Page three café naïve"]:
        pdf.setFont("CorpusUnicode",16); pdf.drawString(60,730,text_value); pdf.rect(60,580,360,100); pdf.line(240,580,240,680); pdf.showPage()
    pdf.save(); writer = PdfWriter(); reader = PdfReader(raw)
    for index,page in enumerate(reader.pages):
        if index == 1: page.rotate(90)
        writer.add_page(page)
    writer.write(folder/"input.pdf"); raw.unlink()

    folder, entry = case("F02", fields={"reviewer":"Maya Synthetic","status":"Approved"})
    pdf = canvas.Canvas(str(folder/"input.pdf")); pdf.drawString(60,750,"Review approval form")
    pdf.acroForm.textfield(name="reviewer",value="Maya Synthetic",x=60,y=680,width=250,height=24); pdf.acroForm.textfield(name="status",value="Approved",x=60,y=630,width=250,height=24); pdf.showPage(); pdf.save()

    folder, entry = case("F03", text="SCAN REVIEW 8642")
    scan = Image.new("RGB",(1600,600),"white"); ImageDraw.Draw(scan).text((100,100),"SCAN REVIEW 8642",fill="black",font_size=72); scan.save(folder/"scan.png")
    pdf = canvas.Canvas(str(folder/"input.pdf")); pdf.drawImage(str(folder/"scan.png"),30,350,width=530,height=199); pdf.showPage(); pdf.save()

    folder, entry = case("F04", attachment="supporting.txt", attachmentText="Keep this exact attachment.")
    pdf = canvas.Canvas(str(folder/"base.pdf")); pdf.drawString(60,750,"Report cover"); pdf.bookmarkPage("cover"); pdf.addOutlineEntry("Report cover","cover",0); pdf.linkAbsolute("Go to details","details",Rect=(60,680,200,710)); pdf.showPage(); pdf.drawString(60,750,"Report details"); pdf.bookmarkPage("details"); pdf.addOutlineEntry("Report details","details",0); pdf.showPage(); pdf.save()
    writer = PdfWriter(clone_from=folder/"base.pdf"); writer.add_attachment("supporting.txt",b"Keep this exact attachment."); writer.write(folder/"input.pdf"); (folder/"base.pdf").unlink()
    pdf = canvas.Canvas(str(folder/"appendix.pdf")); pdf.drawString(60,750,"Appendix retained"); pdf.showPage(); pdf.save()

    folder, entry = case("F05", text="Révision approuvée — تمت المراجعة — 東京")
    shutil.copyfile(font_path,folder/"covering.ttf")

    folder, entry = case("W01", total=18)
    with (folder/"records.csv").open("w",newline="") as handle: csv.writer(handle).writerows([["ID","Units"],["0001",3],["0002",6],["0003",9]])
    document = word_base(); document.add_heading("Synthetic delivery report",0); document.add_paragraph("Total units: PLACEHOLDER"); document.add_picture(str(chart),width=WordInches(3)); document.save(folder/"report.docx")
    presentation,slide = slide_base(); textbox(slide,"Total units: PLACEHOLDER"); slide.shapes.add_picture(str(chart),Inches(1),Inches(2),width=Inches(6)); presentation.save(folder/"summary.pptx")
    pdf = canvas.Canvas(str(folder/"appendix.pdf")); pdf.drawString(60,750,"Independent appendix retained"); pdf.showPage(); pdf.save()

    for entry in cases:
        entry["sources"] = [{"path":file.name,"sha256":digest(file)} for file in sorted(Path(entry["directory"]).iterdir()) if file.is_file()]
    manifest = {"declaredCases":len(cases),"producer":"independent Python libraries","cases":cases}
    (root/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    print(json.dumps({"generated":len(cases),"root":str(root)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("root",type=Path); parser.add_argument("--font",type=Path,required=True)
    args = parser.parse_args(); main(args.root,args.font)
