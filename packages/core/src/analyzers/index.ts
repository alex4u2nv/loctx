export {
  AST_GREP_VERSION,
  bundledAstGrepRulesDir,
  detectAstGrep,
  parseAstGrepJson,
  type RunAstGrepOptions,
  runAstGrep,
  sgConfigForRuleDirs,
} from "./ast-grep.js";
export {
  compileDefinitionSchema,
  DEFINITIONS_VERSION,
  type DefinitionSchemaSpec,
  extractFrontmatter,
  extractMarkdownLinks,
  findBrokenLinks,
  inferDefinitionSchema,
  loadSchemaFile,
  matchesDefinitionGlobs,
  OKF_V01_SCHEMA,
  type RunDefinitionsOptions,
  resolveDefinitionSchemas,
  resolvedMarkdownLinks,
  runDefinitions,
  validateDefinition,
} from "./definitions.js";
export {
  computeDuplicateWindows,
  DUPLICATES_VERSION,
  type DuplicatesOptions,
  type DuplicatesPayload,
  type DuplicateWindow,
} from "./duplicates.js";
export {
  detectLizard,
  LIZARD_VERSION,
  type LizardFileResult,
  type LizardFunctionMetric,
  parseLizardCsv,
  runLizard,
} from "./lizard.js";
export {
  computeQualityFindings,
  DEFAULT_QUALITY_THRESHOLDS,
  type DuplicateGroupLike,
  type ExtractCandidate,
  extractCandidates,
  fanInFinding,
  QUALITY_VERSION,
  type QualityChunkInfo,
  type QualityIndexReader,
  type QualityInput,
  type QualityOptions,
  type QualityThresholds,
  runQuality,
} from "./quality.js";
export {
  docDriftFinding,
  extractPathRefs,
  isMarkdownPath,
  type MarkdownVectorPort,
  type PathRef,
  type ResolvedRef,
  resolvePathRefs,
  runDocDrift,
  runMarkdownStaleRefs,
  staleRefFindings,
} from "./quality-markdown.js";
export {
  EnrichmentQueue,
  type EnrichmentQueueOptions,
  type EnrichmentResult,
  type EnrichmentStatus,
  type EnrichmentTask,
} from "./queue.js";
export {
  capFindings,
  detectCommand,
  normalizeSeverity,
  type RulePackFileResult,
  type RulePackFinding,
} from "./rule-pack.js";
export {
  findSemanticDuplicateGroups,
  type SemanticChunk,
  type SemanticDuplicateGroup,
  type SemanticDuplicateMember,
  type SemanticDuplicatesOptions,
  type SemanticDuplicatesResult,
} from "./semantic-duplicates.js";
export {
  detectSemgrep,
  parseSemgrepJson,
  type RunSemgrepOptions,
  runSemgrep,
  SEMGREP_VERSION,
} from "./semgrep.js";
export { dot, round4, toUnit } from "./vector-math.js";
