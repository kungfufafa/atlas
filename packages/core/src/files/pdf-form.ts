import {
  PDFCheckBox,
  PDFDict,
  type PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from "pdf-lib";

export function readPdfFormFields(
  document: PDFDocument,
  start = 1,
  limit = 50
) {
  const xfaExcluded = Boolean(
    document.catalog
      .lookupMaybe(PDFName.of("AcroForm"), PDFDict)
      ?.has(PDFName.of("XFA"))
  );
  const fields = document.getForm().getFields();
  const selected = fields.slice(start - 1, start - 1 + limit).map((field) => {
    let value: string | string[] | boolean | null = null;
    let readable = true;
    let type = "unsupported";
    if (field instanceof PDFTextField) {
      value = field.getText() ?? "";
      type = "text";
    } else if (field instanceof PDFCheckBox) {
      value = field.isChecked();
      type = "checkbox";
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      value = field.getSelected();
      type = field instanceof PDFDropdown ? "dropdown" : "list";
    } else if (field instanceof PDFRadioGroup) {
      value = field.getSelected() ?? null;
      type = "radio";
    } else {
      readable = false;
    }
    const originalName = field.getName();
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const truncated =
      Buffer.byteLength(raw) > 4000 || originalName.length > 1000;
    if (Buffer.byteLength(raw) > 4000) {
      let text = "";
      let bytes = 0;
      for (const character of raw) {
        bytes += Buffer.byteLength(character);
        if (bytes > 4000) {
          break;
        }
        text += character;
      }
      value = text;
    }
    return {
      name: originalName.slice(0, 1000),
      readable,
      truncated,
      type,
      value,
    };
  });
  return {
    complete:
      !xfaExcluded &&
      start === 1 &&
      selected.length === fields.length &&
      selected.every((field) => field.readable && !field.truncated),
    fields: selected,
    nextStart:
      start - 1 + selected.length < fields.length
        ? start + selected.length
        : null,
    start,
    totalFields: fields.length,
    xfaExcluded,
  };
}
