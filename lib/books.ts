import fs from "node:fs";
import path from "node:path";
import {
  CREDIT_ROLE_META,
  getBookChapterSectionNumber,
  getPostBySlug,
  hashRenderedContent,
  readMinutes,
  type Credit,
  type CreditRole,
  type Post,
} from "./posts";
import { renderMarkdown } from "./markdown";
import { findContributor, findContributorByName } from "./contributors";
import {
  bookCitationDefaults,
  mergeCitation,
  parseCitationInput,
  type CitationCreator,
  type CitationRecord,
} from "./citations";
import { isHanScript, type HanScript } from "./han-script";
import { validateBookChapterSectionHeadings } from "./book-section-contract.mjs";

const BOOKS_DIR = path.join(process.cwd(), "source", "_books");
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const BOOK_STATUSES = ["serializing", "complete", "paused"] as const;
export const BOOK_CHAPTER_STATUSES = ["published", "forthcoming"] as const;
export const BOOK_CHAPTER_PRESENTATIONS = ["reading", "reference", "navigation"] as const;

export type BookStatus = (typeof BOOK_STATUSES)[number];
export type BookChapterStatus = (typeof BOOK_CHAPTER_STATUSES)[number];
export type BookChapterPresentation = (typeof BOOK_CHAPTER_PRESENTATIONS)[number];

const BOOK_STATUS_ORDER: Record<BookStatus, number> = {
  serializing: 0,
  paused: 1,
  complete: 2,
};

interface BookChapterSectionBase {
  id: string;
  number: string;
  title: string;
  status: BookChapterStatus;
}

export interface PublishedBookChapterSection extends BookChapterSectionBase {
  status: "published";
  anchor: string;
  publishedAt: string;
}

export interface ForthcomingBookChapterSection extends BookChapterSectionBase {
  status: "forthcoming";
}

export type BookChapterSection = PublishedBookChapterSection | ForthcomingBookChapterSection;

interface BookChapterBase {
  id: string;
  number: string;
  title: string;
  tags: string[];
  status: BookChapterStatus;
  presentation: BookChapterPresentation;
  sections: BookChapterSection[];
  children: BookChapter[];
}

export interface PublishedBookChapter extends BookChapterBase {
  status: "published";
  anchor: string;
  publishedAt: string;
}

export interface ForthcomingBookChapter extends BookChapterBase {
  status: "forthcoming";
}

export type BookChapter = PublishedBookChapter | ForthcomingBookChapter;

export interface BookCoverAsset {
  src: string;
}

const BOOK_COVER_ASSETS: Record<string, BookCoverAsset> = {
  "capital-untamed": {
    src: "/img/capital-untamed-cover.png",
  },
  "crouzet-la-grande-inflation": {
    src: "/img/crouzet-la-grande-inflation-cover.jpg",
  },
  "nakamura-showa-kyoko-to-keizai-seisaku": {
    src: "/img/nakamura-showa-kyoko-to-keizai-seisaku-cover.jpg",
  },
  "yanbe-nihon-keizai-30nenshi": {
    src: "/img/yanbe-nihon-keizai-30nenshi-cover.jpg",
  },
  "takagi-meiji-ishin-to-gounou": {
    src: "/img/takagi-meiji-ishin-to-gounou-cover.jpg",
  },
};

export function getBookCoverAssets(slug: string): BookCoverAsset | undefined {
  return BOOK_COVER_ASSETS[slug];
}

export interface BookChapterDocument {
  chapter: PublishedBookChapter;
  html: string;
  headings: BookChapterHeading[];
  contentRevision: string;
  readMin: number;
  isSectionLanding: boolean;
  section: Post["section"];
  sectionNo: string;
  tags: string[];
}

export interface BookChapterHeading {
  id: string;
  title: string;
  level: number;
}

export interface Book {
  id: string;
  slug: string;
  title: string;
  /** Optional: books whose original edition carries no subtitle omit it rather than invent one. */
  subtitle?: string;
  description: string;
  documentSlug: string;
  script: HanScript;
  status: BookStatus;
  authors: string[];
  translators: string[];
  proofreaders: string[];
  publishedAt: string;
  updatedAt: string;
  latestChapterId: string;
  chapters: BookChapter[];
  originalCitation?: CitationRecord;
  translationCitation: CitationRecord;
  pdfUrl?: string;
  epubUrl?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(source: string, field: string, detail: string): never {
  throw new Error(`[books] ${source}: ${field} ${detail}`);
}

function requiredString(record: JsonRecord, field: string, source: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) fail(source, field, "must be a non-empty string");
  return value.trim();
}

function stableId(record: JsonRecord, field: string, source: string): string {
  const value = requiredString(record, field, source);
  if (!STABLE_ID.test(value)) fail(source, field, "must use lowercase ASCII words separated by hyphens");
  return value;
}

function dateString(record: JsonRecord, field: string, source: string): string {
  const value = requiredString(record, field, source);
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail(source, field, "must be an ISO date (YYYY-MM-DD)");
  }
  return value;
}

function stringList(record: JsonRecord, field: string, source: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(source, field, "must be an array of non-empty strings");
  }
  return value.map((item) => (item as string).trim());
}

function optionalStringList(record: JsonRecord, field: string, source: string): string[] {
  return record[field] == null ? [] : stringList(record, field, source);
}

function optionalString(record: JsonRecord, field: string, source: string): string | undefined {
  const value = record[field];
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    fail(source, field, "must be a non-empty string when provided");
  }
  return value.trim();
}

function optionalFileUrl(record: JsonRecord, field: string, source: string): string | undefined {
  const value = optionalString(record, field, source);
  if (!value) return undefined;

  if (value.startsWith("/")) {
    try {
      const base = new URL("https://un-canon.invalid");
      if (new URL(value, base).origin === base.origin) return value;
    } catch {
      // Report the field-specific URL validation error below.
    }
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
  } catch {
    // Report a field-specific manifest error below.
  }
  fail(source, field, "must be a root-relative, HTTP, or HTTPS URL");
}

function resolveContributor(value: string) {
  const candidate = value.trim();
  return findContributor(candidate) ?? findContributorByName(candidate);
}

function validateContributorNames(names: string[], field: string, source: string): void {
  names.forEach((name) => {
    if (!resolveContributor(name)) {
      fail(source, field, `contains unregistered contributor ${name}`);
    }
  });
}

function parseChapterSection(
  value: unknown,
  index: number,
  source: string,
  parentForthcoming: boolean
): BookChapterSection {
  const sectionSource = `${source} section ${index + 1}`;
  if (!isRecord(value)) fail(sectionSource, "entry", "must be an object");

  if (value.status === undefined) {
    fail(sectionSource, "status", "must be declared explicitly");
  }
  const declaredStatus = requiredString(value, "status", sectionSource);
  if (!BOOK_CHAPTER_STATUSES.includes(declaredStatus as BookChapterStatus)) {
    fail(sectionSource, "status", `must be one of ${BOOK_CHAPTER_STATUSES.join(", ")}`);
  }
  const status = declaredStatus as BookChapterStatus;
  if (parentForthcoming && status === "published") {
    fail(sectionSource, "status", "cannot be published beneath a forthcoming chapter");
  }

  const base = {
    id: stableId(value, "id", sectionSource),
    number: requiredString(value, "number", sectionSource),
    title: requiredString(value, "title", sectionSource),
  };

  if (status === "published") {
    return {
      ...base,
      status,
      anchor: requiredString(value, "anchor", sectionSource),
      publishedAt: dateString(value, "publishedAt", sectionSource),
    };
  }

  for (const field of ["anchor", "publishedAt"]) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      fail(sectionSource, field, "must be omitted for a forthcoming section");
    }
  }

  return { ...base, status };
}

function parseChapter(
  value: unknown,
  index: number,
  source: string,
  ancestorForthcoming = false
): BookChapter {
  const chapterSource = `${source} chapter ${index + 1}`;
  if (!isRecord(value)) fail(chapterSource, "entry", "must be an object");

  const declaredStatus = value.status === undefined
    ? "published"
    : requiredString(value, "status", chapterSource);
  if (!BOOK_CHAPTER_STATUSES.includes(declaredStatus as BookChapterStatus)) {
    fail(chapterSource, "status", `must be one of ${BOOK_CHAPTER_STATUSES.join(", ")}`);
  }
  const status = declaredStatus as BookChapterStatus;
  if (ancestorForthcoming && status === "published") {
    fail(chapterSource, "status", "cannot be published beneath a forthcoming ancestor");
  }
  const declaredPresentation = value.presentation === undefined
    ? "reading"
    : requiredString(value, "presentation", chapterSource);
  if (!BOOK_CHAPTER_PRESENTATIONS.includes(declaredPresentation as BookChapterPresentation)) {
    fail(
      chapterSource,
      "presentation",
      `must be one of ${BOOK_CHAPTER_PRESENTATIONS.join(", ")}`
    );
  }

  let sections: BookChapterSection[] = [];
  if (value.sections !== undefined) {
    if (!Array.isArray(value.sections)) fail(chapterSource, "sections", "must be an array when provided");
    sections = value.sections.map((section, sectionIndex) =>
      parseChapterSection(section, sectionIndex, chapterSource, status === "forthcoming")
    );
    let encounteredForthcoming = false;
    sections.forEach((section) => {
      if (section.status === "forthcoming") encounteredForthcoming = true;
      else if (encounteredForthcoming) {
        fail(chapterSource, "sections", "published sections must precede forthcoming sections");
      }
    });
    if (declaredPresentation !== "reading") {
      fail(chapterSource, "sections", "are only supported by reading chapters");
    }
  }

  let children: BookChapter[] = [];
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) fail(chapterSource, "children", "must be an array when provided");
    children = value.children.map((child, childIndex) =>
      parseChapter(child, childIndex, chapterSource, ancestorForthcoming || status === "forthcoming")
    );
  }
  if (sections.length > 0 && children.length > 0) {
    fail(chapterSource, "sections", "cannot be combined with child chapter routes");
  }

  const base = {
    id: stableId(value, "id", chapterSource),
    number: requiredString(value, "number", chapterSource),
    title: requiredString(value, "title", chapterSource),
    tags: Array.from(new Set(optionalStringList(value, "tags", chapterSource))),
    presentation: declaredPresentation as BookChapterPresentation,
    sections,
    children,
  };

  if (status === "published") {
    return {
      ...base,
      status,
      anchor: requiredString(value, "anchor", chapterSource),
      publishedAt: dateString(value, "publishedAt", chapterSource),
    };
  }

  for (const field of ["anchor", "publishedAt"]) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      fail(chapterSource, field, "must be omitted for a forthcoming chapter");
    }
  }

  return {
    ...base,
    status,
  };
}

function flattenChapters(chapters: readonly BookChapter[]): BookChapter[] {
  return chapters.flatMap((chapter) => [chapter, ...flattenChapters(chapter.children)]);
}

export function isPublishedBookChapter(chapter: BookChapter): chapter is PublishedBookChapter {
  return chapter.status === "published";
}

export function isPublishedBookChapterSection(
  section: BookChapterSection
): section is PublishedBookChapterSection {
  return section.status === "published";
}

function parseManifest(value: unknown, source: string): Book {
  if (!isRecord(value)) fail(source, "manifest", "must contain a JSON object");

  const status = requiredString(value, "status", source);
  if (!BOOK_STATUSES.includes(status as BookStatus)) {
    fail(source, "status", `must be one of ${BOOK_STATUSES.join(", ")}`);
  }

  if (!Array.isArray(value.chapters) || value.chapters.length === 0) {
    fail(source, "chapters", "must contain at least one chapter");
  }
  const chapters = value.chapters.map((chapter, index) => parseChapter(chapter, index, source));
  const allChapters = flattenChapters(chapters);
  const chapterIds = new Set<string>();
  const chapterNumbers = new Set<string>();
  const chapterAnchors = new Set<string>();
  allChapters.forEach((chapter) => {
    if (chapterIds.has(chapter.id)) fail(source, "chapters", `contains duplicate id ${chapter.id}`);
    if (chapterNumbers.has(chapter.number)) {
      fail(source, "chapters", `contains duplicate number ${chapter.number}`);
    }
    if (isPublishedBookChapter(chapter) && chapterAnchors.has(chapter.anchor)) {
      fail(source, "chapters", `contains duplicate anchor ${chapter.anchor}`);
    }
    chapterIds.add(chapter.id);
    chapterNumbers.add(chapter.number);
    if (isPublishedBookChapter(chapter)) chapterAnchors.add(chapter.anchor);
    chapter.sections.forEach((section) => {
      if (chapterIds.has(section.id)) fail(source, "chapters", `contains duplicate id ${section.id}`);
      if (chapterNumbers.has(section.number)) {
        fail(source, "chapters", `contains duplicate number ${section.number}`);
      }
      if (isPublishedBookChapterSection(section) && chapterAnchors.has(section.anchor)) {
        fail(source, "chapters", `contains duplicate anchor ${section.anchor}`);
      }
      chapterIds.add(section.id);
      chapterNumbers.add(section.number);
      if (isPublishedBookChapterSection(section)) chapterAnchors.add(section.anchor);
    });
  });

  const latestChapterId = stableId(value, "latestChapterId", source);
  const latestChapter = allChapters.find((chapter) => chapter.id === latestChapterId);
  if (!latestChapter) {
    fail(source, "latestChapterId", `does not match a declared chapter (${latestChapterId})`);
  }
  if (!isPublishedBookChapter(latestChapter)) {
    fail(source, "latestChapterId", `must point to a published chapter (${latestChapterId})`);
  }

  const authors = stringList(value, "authors", source);
  const translators = stringList(value, "translators", source);
  const proofreaders = optionalStringList(value, "proofreaders", source);
  validateContributorNames(authors, "authors", source);
  validateContributorNames(translators, "translators", source);
  validateContributorNames(proofreaders, "proofreaders", source);
  const slug = stableId(value, "slug", source);
  const title = requiredString(value, "title", source);
  const subtitle = optionalString(value, "subtitle", source);
  const description = requiredString(value, "description", source);
  const rawScript = requiredString(value, "script", source);
  if (!isHanScript(rawScript)) {
    fail(source, "script", "must be hans or hant");
  }
  const script = rawScript;
  const publishedAt = dateString(value, "publishedAt", source);
  const citationCreators: CitationCreator[] = [
    ...authors.map((name): CitationCreator => ({
      creatorType: "author",
      name: resolveContributor(name)?.displayName ?? name,
    })),
    ...translators.map((name): CitationCreator => ({
      creatorType: "translator",
      name: resolveContributor(name)?.displayName ?? name,
    })),
  ];
  if (!isRecord(value.citations)) fail(source, "citations", "must be an object");
  const translationInput = parseCitationInput(
    value.citations.translation,
    `${source}: citations.translation`
  );
  if (translationInput.itemType !== "book") {
    fail(source, "citations.translation.itemType", "must be book");
  }
  const translationCitation = mergeCitation(
    bookCitationDefaults({
      slug,
      script,
      title,
      subtitle,
      creators: citationCreators,
      date: publishedAt,
      abstractNote: description,
    }),
    translationInput,
    `${source}: citations.translation`
  );

  let originalCitation: CitationRecord | undefined;
  if (value.citations.original != null) {
    const input = parseCitationInput(value.citations.original, `${source}: citations.original`);
    if (input.itemType !== "book") fail(source, "citations.original.itemType", "must be book");
    originalCitation = mergeCitation(
      {
        itemType: "book",
        citationKey: input.citationKey ?? "",
        title: input.title ?? "",
        creators: input.creators ?? [],
      },
      input,
      `${source}: citations.original`
    );
  }

  return {
    id: stableId(value, "id", source),
    slug,
    title,
    subtitle,
    description,
    documentSlug: stableId(value, "documentSlug", source),
    script,
    status: status as BookStatus,
    authors,
    translators,
    proofreaders,
    publishedAt,
    updatedAt: dateString(value, "updatedAt", source),
    latestChapterId,
    chapters,
    originalCitation,
    translationCitation,
    pdfUrl: optionalFileUrl(value, "pdfUrl", source),
    epubUrl: optionalFileUrl(value, "epubUrl", source),
  };
}

export function getAllBooks(): Book[] {
  if (!fs.existsSync(BOOKS_DIR)) return [];

  const books = fs
    .readdirSync(BOOKS_DIR)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_") && !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((name) => {
      const source = path.join("source", "_books", name);
      const raw = fs.readFileSync(path.join(BOOKS_DIR, name), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`[books] ${source}: invalid JSON (${detail})`);
      }
      return parseManifest(parsed, source);
    });

  const ids = new Set<string>();
  const slugs = new Set<string>();
  const documentSlugs = new Set<string>();
  books.forEach((book) => {
    if (ids.has(book.id)) fail("source/_books", "id", `is duplicated (${book.id})`);
    if (slugs.has(book.slug)) fail("source/_books", "slug", `is duplicated (${book.slug})`);
    if (documentSlugs.has(book.documentSlug)) {
      fail("source/_books", "documentSlug", `is used by more than one book (${book.documentSlug})`);
    }
    ids.add(book.id);
    slugs.add(book.slug);
    documentSlugs.add(book.documentSlug);
  });

  return books.sort(
    (a, b) =>
      BOOK_STATUS_ORDER[a.status] - BOOK_STATUS_ORDER[b.status] ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.title.localeCompare(b.title, "zh-CN")
  );
}

export function getBookBySlug(slug: string): Book | null {
  return getAllBooks().find((book) => book.slug === slug) ?? null;
}

export function getBookByDocumentSlug(documentSlug: string): Book | null {
  return getAllBooks().find((book) => book.documentSlug === documentSlug) ?? null;
}

export function getBookCredits(
  book: Pick<Book, "slug" | "authors" | "translators" | "proofreaders">
): Credit[] {
  const rows: Array<{ role: CreditRole; names: string[] }> = [
    { role: "author", names: book.authors },
    { role: "translator", names: book.translators },
    { role: "proofreader", names: book.proofreaders },
  ];

  return rows.flatMap(({ role, names }) => names.map((name) => {
    const contributor = resolveContributor(name);
    if (!contributor) throw new Error(`[books] ${book.slug}: unregistered contributor ${name}`);
    const meta = CREDIT_ROLE_META[role];
    return {
      role,
      contributorId: contributor.id,
      name: contributor.displayName,
      mark: meta.mark,
      solid: meta.solid,
    };
  }));
}

export function getAllBookChapters(book: Pick<Book, "chapters">): BookChapter[] {
  return flattenChapters(book.chapters);
}

export function getPublishedBookChapters(book: Pick<Book, "chapters">): PublishedBookChapter[] {
  return getAllBookChapters(book).filter(isPublishedBookChapter);
}

export function getBookChapter(book: Book, chapterId: string): BookChapter | null {
  return getAllBookChapters(book).find((chapter) => chapter.id === chapterId) ?? null;
}

export function getLatestBookChapter(book: Book): PublishedBookChapter {
  const chapter = getBookChapter(book, book.latestChapterId);
  if (!chapter || !isPublishedBookChapter(chapter)) {
    throw new Error(`[books] ${book.slug}: latest published chapter is missing`);
  }
  return chapter;
}

export function bookHref(book: Pick<Book, "slug">): string {
  return `/books/${encodeURIComponent(book.slug)}`;
}

export function bookChapterHref(
  book: Pick<Book, "slug">,
  chapter: Pick<BookChapter, "id">
): string {
  return `${bookHref(book)}/chapters/${encodeURIComponent(chapter.id)}`;
}

function renderedIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
}

/** Fail the build when a manifest points at a missing document or heading anchor. */
export async function getValidatedBookDocument(book: Book): Promise<Post> {
  const post = await getPostBySlug(book.documentSlug);
  if (!post) {
    throw new Error(`[books] ${book.slug}: document ${book.documentSlug} does not exist`);
  }
  if (!post.bookDocument) {
    throw new Error(`[books] ${book.slug}: document ${book.documentSlug} must declare book_document: true`);
  }

  const ids = renderedIds(post.html);
  for (const chapter of getPublishedBookChapters(book)) {
    if (!ids.has(chapter.anchor)) {
      throw new Error(
        `[books] ${book.slug}: chapter ${chapter.id} points to missing rendered id #${chapter.anchor}`
      );
    }
    for (const section of chapter.sections) {
      if (isPublishedBookChapterSection(section) && !ids.has(section.anchor)) {
        throw new Error(
          `[books] ${book.slug}: section ${section.id} points to missing rendered id #${section.anchor}`
        );
      }
    }
  }
  return post;
}

type FootnoteDefinition = { id: string; markdown: string };

function extractFootnoteDefinitions(markdown: string): {
  lines: string[];
  definitions: Map<string, FootnoteDefinition>;
} {
  const lines = markdown.split(/\r?\n/u);
  const definitions = new Map<string, FootnoteDefinition>();

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\[\^([^\]]+)\]:[ \t]*(.*)$/u.exec(lines[index]);
    if (!match) continue;

    const definitionLines = [lines[index]];
    let cursor = index + 1;
    while (cursor < lines.length) {
      if (/^(?: {2,}|\t)\S/u.test(lines[cursor])) {
        definitionLines.push(lines[cursor]);
        cursor += 1;
        continue;
      }
      if (
        lines[cursor].trim() === "" &&
        cursor + 1 < lines.length &&
        /^(?: {2,}|\t)\S/u.test(lines[cursor + 1])
      ) {
        definitionLines.push(lines[cursor]);
        cursor += 1;
        continue;
      }
      break;
    }

    definitions.set(match[1], { id: match[1], markdown: definitionLines.join("\n") });
    for (let lineIndex = index; lineIndex < cursor; lineIndex += 1) lines[lineIndex] = "";
    index = cursor - 1;
  }

  return { lines, definitions };
}

function footnoteReferences(markdown: string): string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(/\[\^([^\]]+)\]/gu)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      references.push(match[1]);
    }
  }
  return references;
}

function appendReferencedFootnotes(
  markdown: string,
  definitions: ReadonlyMap<string, FootnoteDefinition>,
  source: string
): string {
  const references = footnoteReferences(markdown);
  const seen = new Set(references);

  for (let index = 0; index < references.length; index += 1) {
    const id = references[index];
    const definition = definitions.get(id);
    if (!definition) throw new Error(`[books] ${source}: missing footnote definition [^${id}]`);
    for (const nested of footnoteReferences(definition.markdown)) {
      if (!seen.has(nested)) {
        seen.add(nested);
        references.push(nested);
      }
    }
  }

  const appendix = references.map((id) => definitions.get(id)?.markdown).filter(Boolean).join("\n\n");
  return [markdown.trim(), appendix].filter(Boolean).join("\n\n");
}

function markdownHeadingLines(lines: readonly string[]): Array<{ line: number; markdown: string }> {
  const headings: Array<{ line: number; markdown: string }> = [];
  let fence: "`" | "~" | null = null;

  lines.forEach((line, index) => {
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (!fence && /^#{1,6}[ \t]+\S/u.test(line)) headings.push({ line: index, markdown: line });
  });

  return headings;
}

async function chapterHeadingLines(markdownLines: readonly string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const markdownHeadings = markdownHeadingLines(markdownLines);

  if (markdownHeadings.length > 0) {
    const rendered = await renderMarkdown(markdownHeadings.map((heading) => heading.markdown).join("\n\n"));
    const ids = [...rendered.matchAll(/<h[1-6]\b[^>]*\bid="([^"]+)"[^>]*>/gu)]
      .map((match) => match[1]);
    if (ids.length !== markdownHeadings.length) {
      throw new Error("[books] could not map Markdown headings to rendered chapter anchors");
    }
    ids.forEach((id, index) => result.set(id, markdownHeadings[index].line));
  }

  markdownLines.forEach((line, index) => {
    if (!/<h[1-6]\b/iu.test(line)) return;
    for (const match of line.matchAll(/\bid=["']([^"']+)["']/giu)) result.set(match[1], index);
  });

  return result;
}

const HEADING_ENTITY_TEXT: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  rsquo: "’",
};

function renderedHeadingText(html: string): string {
  return html
    .replace(/<[^>]+>/gu, " ")
    .replace(/&#(?:x([\da-f]+)|(\d+));/giu, (_entity, hexadecimal: string, decimal: string) => {
      const codePoint = Number.parseInt(hexadecimal ?? decimal, hexadecimal ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/&([a-z]+);/giu, (entity, name: string) => HEADING_ENTITY_TEXT[name.toLowerCase()] ?? entity)
    .replace(/\s+/gu, " ")
    .trim();
}

function withoutRenderedSection(html: string, className: string): string {
  return html.replace(
    new RegExp(`<section\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>[\\s\\S]*?<\\/section>`, "giu"),
    ""
  );
}

function renderedChapterHeadings(html: string): BookChapterHeading[] {
  const main = withoutRenderedSection(withoutRenderedSection(html, "footnotes"), "source-notes");
  return [...main.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/giu)].flatMap((match) => {
    const idMatch = /\bid=["']([^"']+)["']/iu.exec(match[2]);
    const title = renderedHeadingText(match[3]);
    if (!idMatch || !title) return [];
    return [{ id: idMatch[1], title, level: Number(match[1]) }];
  });
}

const chapterDocumentCache = new Map<string, Promise<BookChapterDocument[]>>();

export function getBookChapterCitation(
  book: Book,
  chapter: PublishedBookChapter
): CitationRecord {
  const parent = book.translationCitation;
  return {
    itemType: "bookSection",
    citationKey: `${parent.citationKey}_${chapter.id.replaceAll("-", "_")}`,
    title: chapter.title,
    creators: parent.creators,
    abstractNote: `${book.subtitle ? `${book.title}（${book.subtitle}）` : book.title}${chapter.number}：${chapter.title}`,
    date: chapter.publishedAt,
    url: `https://un-canon.blog${bookChapterHref(book, chapter)}`,
    language: parent.language,
    rights: parent.rights,
    extra: parent.extra,
    publisher: parent.publisher,
    place: parent.place,
    series: parent.series,
    seriesNumber: parent.seriesNumber,
    volume: parent.volume,
    edition: parent.edition,
    ISBN: parent.ISBN,
    bookTitle: parent.title,
  };
}

export async function getBookChapterDocuments(book: Book): Promise<BookChapterDocument[]> {
  const cached = chapterDocumentCache.get(book.slug);
  if (cached) return cached;

  const promise = (async () => {
    const post = await getValidatedBookDocument(book);
    const published = getPublishedBookChapters(book);
    const { lines, definitions } = extractFootnoteDefinitions(post.markdown);
    const headingLines = await chapterHeadingLines(lines);
    const starts = published.map((chapter) => {
      const line = headingLines.get(chapter.anchor);
      if (line == null) {
        throw new Error(`[books] ${book.slug}: cannot locate Markdown boundary for #${chapter.anchor}`);
      }
      return line;
    });

    starts.forEach((start, index) => {
      if (index > 0 && start < starts[index - 1]) {
        throw new Error(`[books] ${book.slug}: chapter manifest order differs from the source document`);
      }
    });

    return Promise.all(published.map(async (chapter, index): Promise<BookChapterDocument> => {
      const start = starts[index];
      const end = starts[index + 1] ?? lines.length;
      const body = lines.slice(start + 1, end).join("\n").trim();
      const isSectionLanding = start === end || !body;
      const markdown = appendReferencedFootnotes(
        body,
        definitions,
        `${book.slug}/${chapter.id}`
      );
      const html = markdown ? await renderMarkdown(markdown) : "";
      const headings = renderedChapterHeadings(html);
      validateBookChapterSectionHeadings(book.slug, chapter, headings);
      const sectionNo = await getBookChapterSectionNumber(book.documentSlug, chapter.id);
      return {
        chapter,
        html,
        headings,
        contentRevision: hashRenderedContent(html),
        readMin: html ? readMinutes(html) : 0,
        isSectionLanding,
        section: post.section,
        sectionNo: sectionNo ?? post.sectionNo,
        tags: chapter.tags.length > 0 ? chapter.tags : post.tags,
      };
    }));
  })();

  chapterDocumentCache.set(book.slug, promise);
  return promise;
}

export async function getBookChapterDocument(
  book: Book,
  chapterId: string
): Promise<BookChapterDocument | null> {
  return (await getBookChapterDocuments(book)).find((document) => document.chapter.id === chapterId) ?? null;
}

export function bookStatusLabel(status: BookStatus): string {
  if (status === "serializing") return "连载中";
  if (status === "paused") return "暂停更新";
  return "已完结";
}
