const express = require("express");
const multer = require("multer");
const { z } = require("zod");
const { eq, and, desc } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth } = require("../lib/auth");
const { getAIProvider } = require("../ai");
const { buildUserContext } = require("../lib/context");
const { logActivity } = require("../lib/activity");
const { saveUserFile, FileTooLargeError } = require("../lib/storage");
const { extractText, inferFileType } = require("../lib/extract-text");
const { generateResearchPdf, generateResearchDocx, generateNotePdf, generateNoteDocx } = require("../lib/export-doc");

const router = express.Router();
const auth = requireAuth(db, schema, eq);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function loadProject(projectId, userId) {
  const rows = await db.select().from(schema.researchProjects).where(eq(schema.researchProjects.id, projectId)).limit(1);
  const project = rows[0];
  if (!project || project.userId !== userId) return null;
  return project;
}

// List all research projects for the user
router.get("/", auth, async (req, res) => {
  const projects = await db
    .select()
    .from(schema.researchProjects)
    .where(eq(schema.researchProjects.userId, req.user.id))
    .orderBy(desc(schema.researchProjects.updatedAt));
  res.json({ projects });
});

const projectSchema = z.object({
  title: z.string().min(1).max(200),
  researchQuestion: z.string().max(2000).optional(),
});

// Create a new research project
router.post("/", auth, async (req, res) => {
  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const [project] = await db.insert(schema.researchProjects).values({ userId: req.user.id, ...parsed.data }).returning();
  await logActivity(db, schema, req.user.id, "research_project_created", `Started a research project: ${project.title}`);
  res.json({ project });
});

// Get a single project with its documents and notes
router.get("/:id", auth, async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: "Research project not found." });

  const documents = await db
    .select()
    .from(schema.researchDocuments)
    .where(eq(schema.researchDocuments.projectId, project.id))
    .orderBy(desc(schema.researchDocuments.createdAt));
  const notes = await db
    .select()
    .from(schema.researchNotes)
    .where(eq(schema.researchNotes.projectId, project.id))
    .orderBy(desc(schema.researchNotes.createdAt));

  res.json({
    project,
    documents: documents.map((d) => ({ ...d, extractedText: undefined })),
    notes,
  });
});

// Update a project (title / research question / status)
const updateProjectSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  researchQuestion: z.string().max(2000).optional(),
  status: z.enum(["active", "completed", "archived"]).optional(),
});
router.patch("/:id", auth, async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: "Research project not found." });

  const parsed = updateProjectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const [updated] = await db
    .update(schema.researchProjects)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(schema.researchProjects.id, project.id))
    .returning();
  res.json({ project: updated });
});

// Delete a project (cascades to its documents and notes)
router.delete("/:id", auth, async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: "Research project not found." });
  await db.delete(schema.researchProjects).where(eq(schema.researchProjects.id, project.id));
  res.json({ success: true });
});

// Upload a document to a project — extracts text so the AI can read it
router.post("/:id/documents", auth, upload.single("file"), async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: "Research project not found." });
  if (!req.file) return res.status(400).json({ error: "No file provided." });

  const fileType = inferFileType(req.file.originalname);
  if (!fileType) return res.status(400).json({ error: "Only PDF and DOCX files are supported." });

  let storagePath;
  try {
    ({ storagePath } = await saveUserFile({ userId: req.user.id, category: "research", fileName: req.file.originalname, buffer: req.file.buffer }));
  } catch (e) {
    if (e instanceof FileTooLargeError) return res.status(400).json({ error: "File exceeds the 10MB limit." });
    throw e;
  }

  let extractedText = "";
  try {
    extractedText = await extractText(req.file.buffer, fileType);
  } catch (e) {
    console.error("Research document extraction failed:", e);
    return res.status(400).json({ error: "Couldn't read that file. It may be corrupted or scanned as an image." });
  }

  const [doc] = await db
    .insert(schema.researchDocuments)
    .values({ projectId: project.id, fileName: req.file.originalname, fileType, storagePath, extractedText })
    .returning();

  await db.update(schema.researchProjects).set({ updatedAt: new Date() }).where(eq(schema.researchProjects.id, project.id));
  await logActivity(db, schema, req.user.id, "research_document_uploaded", `Uploaded "${req.file.originalname}" to ${project.title}`);
  res.json({ document: { ...doc, extractedText: undefined } });
});

// Delete a document from a project
router.delete("/:id/documents/:docId", auth, async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: "Research project not found." });

  const rows = await db.select().from(schema.researchDocuments).where(eq(schema.researchDocuments.id, req.params.docId)).limit(1);
  if (!rows[0] || rows[0].projectId !== project.id) return res.status(404).json({ error: "Document not found." });

  await db.delete(schema.researchDocuments).where(eq(schema.researchDocuments.id, req.params.docId));
  res.json({ success: true });
});

// Ask the AI a research question — draws on general knowledge AND any uploaded documents in the project
const askSchema = z.object({ question: z.string().min(1).max(2000) });
router.post("/:id/ask", auth, async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: "Research project not found." });

  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const documents = await db.select().from(schema.researchDocuments).where(eq(schema.researchDocuments.projectId, project.id));
  const docContext = documents
    .filter((d) => d.extractedText)
    .map((d) => `--- Document: ${d.fileName} ---\n${d.extractedText.slice(0, 4000)}`)
    .join("\n\n")
    .slice(0, 12000);

  const context = await buildUserContext(db, schema, req.user.id, "research");
  const provider = getAIProvider();

  const result = await provider.generateStructured({
    usage: { user: req.user, feature: "research" },
    system: `You are Orivon's research assistant. Help the user think through their research project titled "${project.title}"${project.researchQuestion ? ` (research question: ${project.researchQuestion})` : ""}.
${docContext ? "The user has uploaded documents below — ground your answer in them wherever relevant, and say clearly when you're drawing on general knowledge instead of their documents." : "The user has not uploaded any documents yet — answer from general knowledge, and mention that uploading source documents will let you ground answers more precisely."}
Be substantive and specific. Never fabricate citations, statistics, or sources — if you reference outside facts, clearly caveat that they should be verified.\n${context}`,
    schemaDescription: `{ "answer": string, "suggestedNextSteps": string[] (2-4), "usedDocuments": boolean }`,
    schema: z.object({
      answer: z.string(),
      suggestedNextSteps: z.array(z.string()),
      usedDocuments: z.boolean(),
    }),
    mockFallback: {
      answer: "This is placeholder analysis. Configure an AI provider (GROQ_API_KEY) to get real research assistance.",
      suggestedNextSteps: ["Add GROQ_API_KEY to .env"],
      usedDocuments: false,
    },
    messages: [
      {
        role: "user",
        content: `${docContext ? `Uploaded documents:\n${docContext}\n\n` : ""}Question: ${parsed.data.question}`,
      },
    ],
  });

  const [note] = await db
    .insert(schema.researchNotes)
    .values({ projectId: project.id, content: `Q: ${parsed.data.question}\n\nA: ${result.answer}`, source: "ai" })
    .returning();

  await db.update(schema.researchProjects).set({ updatedAt: new Date() }).where(eq(schema.researchProjects.id, project.id));
  await logActivity(db, schema, req.user.id, "research_question_asked", `Asked a research question in ${project.title}`);
  res.json({ answer: result.answer, suggestedNextSteps: result.suggestedNextSteps || [], usedDocuments: result.usedDocuments ?? documents.length > 0, note });
});

// Add a manual note to a project
const noteSchema = z.object({ content: z.string().min(1).max(5000), source: z.string().max(200).optional() });
router.post("/:id/notes", auth, async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: "Research project not found." });

  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const [note] = await db.insert(schema.researchNotes).values({ projectId: project.id, content: parsed.data.content, source: parsed.data.source || "manual" }).returning();
  await db.update(schema.researchProjects).set({ updatedAt: new Date() }).where(eq(schema.researchProjects.id, project.id));
  res.json({ note });
});

// Delete a note
router.delete("/:id/notes/:noteId", auth, async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: "Research project not found." });

  const rows = await db.select().from(schema.researchNotes).where(eq(schema.researchNotes.id, req.params.noteId)).limit(1);
  if (!rows[0] || rows[0].projectId !== project.id) return res.status(404).json({ error: "Note not found." });

  await db.delete(schema.researchNotes).where(eq(schema.researchNotes.id, req.params.noteId));
  res.json({ success: true });
});

// Export a single note (e.g. one AI-answered question) as a downloadable PDF or DOCX
router.get("/:id/notes/:noteId/export", auth, async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: "Research project not found." });

  const rows = await db.select().from(schema.researchNotes).where(eq(schema.researchNotes.id, req.params.noteId)).limit(1);
  const note = rows[0];
  if (!note || note.projectId !== project.id) return res.status(404).json({ error: "Note not found." });

  const format = req.query.format === "docx" ? "docx" : "pdf";
  const safeName = project.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40) || "research-note";

  try {
    if (format === "docx") {
      const buffer = await generateNoteDocx({ project, note });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-note.docx"`);
      return res.send(buffer);
    }
    const buffer = await generateNotePdf({ project, note });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}-note.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error("Note export failed:", e);
    res.status(500).json({ error: "Couldn't generate the export file. Try again." });
  }
});

// Export a project's sources and notes as a downloadable PDF or DOCX
router.get("/:id/export", auth, async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: "Research project not found." });

  const format = req.query.format === "docx" ? "docx" : "pdf";
  const documents = await db.select().from(schema.researchDocuments).where(eq(schema.researchDocuments.projectId, project.id));
  const notes = await db
    .select()
    .from(schema.researchNotes)
    .where(eq(schema.researchNotes.projectId, project.id))
    .orderBy(desc(schema.researchNotes.createdAt));

  const safeName = project.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60) || "research-project";

  try {
    if (format === "docx") {
      const buffer = await generateResearchDocx({ project, documents, notes });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.docx"`);
      return res.send(buffer);
    }
    const buffer = await generateResearchPdf({ project, documents, notes });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error("Research export failed:", e);
    res.status(500).json({ error: "Couldn't generate the export file. Try again." });
  }
});

module.exports = router;
