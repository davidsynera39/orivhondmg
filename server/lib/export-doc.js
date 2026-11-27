const path = require("path");
const PDFDocument = require("pdfkit");
const { Document, Packer, Paragraph, HeadingLevel, TextRun, BorderStyle } = require("docx");

// Builds a PDF buffer summarizing a research project: title, question, sources, and notes.
function generateResearchPdf({ project, documents, notes }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text(project.title, { align: "left" });
    if (project.researchQuestion) {
      doc.moveDown(0.5).fontSize(12).fillColor("#555").text(project.researchQuestion);
    }
    doc.fillColor("#000").moveDown(1.5);

    if (documents.length > 0) {
      doc.fontSize(14).text("Sources", { underline: true }).moveDown(0.5);
      documents.forEach((d) => {
        doc.fontSize(11).text(`• ${d.fileName}`);
      });
      doc.moveDown(1.5);
    }

    doc.fontSize(14).text("Notes", { underline: true }).moveDown(0.5);
    if (notes.length === 0) {
      doc.fontSize(11).fillColor("#777").text("No notes yet.");
    } else {
      notes.forEach((n, i) => {
        doc.fontSize(10).fillColor("#888").text(new Date(n.createdAt).toLocaleDateString());
        doc.fontSize(11).fillColor("#000").text(n.content, { paragraphGap: 4 });
        if (i < notes.length - 1) doc.moveDown(1);
      });
    }

    doc.end();
  });
}

// Builds a DOCX buffer summarizing a research project: title, question, sources, and notes.
async function generateResearchDocx({ project, documents, notes }) {
  const children = [
    new Paragraph({ text: project.title, heading: HeadingLevel.TITLE }),
  ];

  if (project.researchQuestion) {
    children.push(new Paragraph({ children: [new TextRun({ text: project.researchQuestion, italics: true, color: "555555" })] }));
  }

  if (documents.length > 0) {
    children.push(new Paragraph({ text: "Sources", heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
    documents.forEach((d) => {
      children.push(new Paragraph({ text: d.fileName, bullet: { level: 0 } }));
    });
  }

  children.push(new Paragraph({ text: "Notes", heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
  if (notes.length === 0) {
    children.push(new Paragraph({ text: "No notes yet." }));
  } else {
    notes.forEach((n) => {
      children.push(new Paragraph({
        children: [new TextRun({ text: new Date(n.createdAt).toLocaleDateString(), color: "888888", size: 18 })],
        spacing: { before: 200 },
      }));
      children.push(new Paragraph({ text: n.content }));
    });
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// Builds a PDF buffer for a single note (e.g. one Q&A entry from a research project).
function generateNotePdf({ project, note }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).text(project.title, { align: "left" });
    doc.fontSize(10).fillColor("#888").text(new Date(note.createdAt).toLocaleDateString());
    doc.moveDown(1).fontSize(12).fillColor("#000").text(note.content);

    doc.end();
  });
}

// Builds a DOCX buffer for a single note (e.g. one Q&A entry from a research project).
async function generateNoteDocx({ project, note }) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: project.title, heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun({ text: new Date(note.createdAt).toLocaleDateString(), color: "888888", size: 18 })] }),
        new Paragraph({ text: note.content, spacing: { before: 200 } }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}


// ---------------------------------------------------------------------------
// CV export. The CV is plain text, so we recognise a little structure:
//   - the first non-empty line is the person's name
//   - SHORT ALL-CAPS lines are section headings (EXPERIENCE, EDUCATION, ...)
//   - lines starting with a bullet character are list items
// Everything else is kept as written. The PDF embeds DejaVu Sans because the
// built-in PDF fonts can't display ₦ or characters like ẹ / ọ.
// ---------------------------------------------------------------------------
const FONT_REGULAR = path.join(__dirname, "..", "assets", "fonts", "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "..", "assets", "fonts", "DejaVuSans-Bold.ttf");
const BULLET_RE = /^[•▪●◦·\-\*]\s+/;

function parseCvLines(text) {
  const out = [];
  let seenName = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { out.push({ kind: "blank" }); continue; }
    if (!seenName) { seenName = true; out.push({ kind: "name", text: line }); continue; }
    if (BULLET_RE.test(line)) { out.push({ kind: "bullet", text: line.replace(BULLET_RE, "") }); continue; }
    const letters = line.replace(/[^\p{L}]/gu, "");
    if (line.length <= 40 && letters.length >= 3 && line === line.toUpperCase() && line !== line.toLowerCase()) {
      out.push({ kind: "heading", text: line }); continue;
    }
    out.push({ kind: "text", text: line });
  }
  return out;
}

function generateCvPdf({ title, text }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, info: { Title: title || "CV" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const lines = parseCvLines(text);
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (l.kind === "blank") { doc.moveDown(0.35); i++; continue; }
      if (l.kind === "name") { doc.font(FONT_BOLD).fontSize(17).fillColor("#000").text(l.text, { paragraphGap: 4 }); i++; continue; }
      if (l.kind === "heading") {
        doc.moveDown(0.6).font(FONT_BOLD).fontSize(11.5).fillColor("#000").text(l.text);
        const y = doc.y + 1;
        doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor("#999").stroke();
        doc.moveDown(0.4); i++; continue;
      }
      if (l.kind === "bullet") {
        const items = [];
        while (i < lines.length && lines[i].kind === "bullet") { items.push(lines[i].text); i++; }
        doc.font(FONT_REGULAR).fontSize(10.5).fillColor("#000").list(items, { bulletRadius: 1.8, textIndent: 14, bulletIndent: 6, paragraphGap: 2 });
        continue;
      }
      doc.font(FONT_REGULAR).fontSize(10.5).fillColor("#000").text(l.text, { paragraphGap: 2 }); i++;
    }
    doc.end();
  });
}

async function generateCvDocx({ title, text }) {
  const children = [];
  for (const l of parseCvLines(text)) {
    if (l.kind === "blank") continue;
    if (l.kind === "name") children.push(new Paragraph({ children: [new TextRun({ text: l.text, bold: true, size: 36 })], spacing: { after: 120 } }));
    else if (l.kind === "heading") children.push(new Paragraph({
      children: [new TextRun({ text: l.text, bold: true, size: 24 })],
      spacing: { before: 240, after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } },
    }));
    else if (l.kind === "bullet") children.push(new Paragraph({ text: l.text, bullet: { level: 0 } }));
    else children.push(new Paragraph({ text: l.text, spacing: { after: 40 } }));
  }
  if (children.length === 0) children.push(new Paragraph({ text: "" }));
  const doc = new Document({
    title: title || "CV",
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { generateCvPdf, generateCvDocx, parseCvLines, generateResearchPdf, generateResearchDocx, generateNotePdf, generateNoteDocx };
