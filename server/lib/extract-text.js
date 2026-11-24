const mammoth = require("mammoth");
const path = require("path");

async function extractText(buffer, fileType) {
  if (fileType === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  }

  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();
  return result.text.trim();
}

function inferFileType(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  return null;
}

module.exports = { extractText, inferFileType };
