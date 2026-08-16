/**
 * Stable content-addressed ids for projects, files, and chunks (#542
 * split from discovery.ts). Pure functions over sha1 digests.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  type ChunkId,
  chunkId,
  type FileId,
  fileId,
  type Project,
  type ProjectId,
  projectId,
} from "./models.js";

const PROJECT_ID_LEN = 16;
const FILE_ID_LEN = 16;
const CHUNK_HASH_LEN = 8;

export function projectIdFor(root: string): ProjectId {
  const canonical = resolve(root);
  const digest = createHash("sha1").update(canonical, "utf-8").digest("hex");
  return projectId(digest.slice(0, PROJECT_ID_LEN));
}

export function fileIdFor(project: Project, relPath: string): FileId {
  const rel = relPath.replaceAll("\\", "/");
  const digest = createHash("sha1").update(`${project.id}:${rel}`, "utf-8").digest("hex");
  return fileId(digest.slice(0, FILE_ID_LEN));
}

export function chunkIdFor(
  fid: FileId,
  startLine: number,
  endLine: number,
  contentSha: string,
): ChunkId {
  const short = contentSha.slice(0, CHUNK_HASH_LEN);
  return chunkId(`${fid}:${pad(startLine)}-${pad(endLine)}:${short}`);
}

function pad(n: number): string {
  return n.toString().padStart(6, "0");
}
