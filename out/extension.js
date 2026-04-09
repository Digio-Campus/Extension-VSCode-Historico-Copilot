"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const Cohere = require("cohere-ai");
const sessionDatabase_1 = require("./sessionDatabase");
const CHAT_PARTICIPANT_ID = 'recuperar-historico-copilot.recuperador';
const SELECT_MODEL_COMMAND_ID = 'recuperar-historico-copilot.selectChatModel';
const EXTENSION_CONFIG_SECTION = 'recuperarHistoricoCopilot';
const WORKSPACE_STORAGE_PATH = 'C:\\Users\\Usuario\\AppData\\Roaming\\Code\\User\\workspaceStorage';
const DATABASE_FILE_NAME = 'historico-sesiones.db';
const MODEL_GLOBAL_STATE_KEY = 'historico.selectedCopilotModelId';
const DEFAULT_MODEL_FAMILY = 'gpt-4.1';
const DEFAULT_EMBEDDINGS_ENDPOINT = 'http://localhost:11434/api/embeddings';
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text:latest';
const DEFAULT_EMBEDDING_DIMENSIONS = 768;
const DEFAULT_COHERE_RERANK_MODEL = 'rerank-v3.5';
const DEFAULT_VECTOR_RESULTS_LIMIT = 10;
const DEFAULT_RERANK_RESULTS_LIMIT = 10;
const DEFAULT_VECTOR_SCORE_WEIGHT = 0.3;
const DEFAULT_RERANK_SCORE_WEIGHT = 0.7;
const DEFAULT_MAX_TOKENS_PER_CHUNK = 128;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 25;
const ALL_COPILOT_MODELS_SELECTOR = {
    vendor: 'copilot',
};
function normalizePathForSearch(value) {
    return value.replaceAll('\\', '/').toLowerCase();
}
function workspacePathToStorageUri(workspacePath) {
    return vscode.Uri.file(workspacePath).toString().toLowerCase();
}
function jsonContainsExactNormalizedPath(value, targetPath) {
    if (typeof value === 'string') {
        return normalizePathForSearch(value) === targetPath;
    }
    if (Array.isArray(value)) {
        return value.some((item) => jsonContainsExactNormalizedPath(item, targetPath));
    }
    if (value && typeof value === 'object') {
        return Object.values(value).some((item) => jsonContainsExactNormalizedPath(item, targetPath));
    }
    return false;
}
function buildJsonlFileKey(jsonlAbsolutePath) {
    return normalizePathForSearch(jsonlAbsolutePath);
}
function readStringSetting(configuration, key, fallback) {
    const raw = configuration.get(key);
    if (typeof raw !== 'string') {
        return fallback;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : fallback;
}
function readNumberSetting(configuration, key, fallback, minimum) {
    const raw = configuration.get(key);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return fallback;
    }
    return Math.max(Math.trunc(raw), minimum);
}
function resolveRuntimeConfiguration() {
    const configuration = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
    const configuredCohereApiKey = configuration.get('cohereApiKey')?.trim() ?? '';
    const environmentCohereApiKey = process.env.COHERE_API_KEY?.trim() ?? '';
    return {
        embeddingsEndpoint: readStringSetting(configuration, 'embeddingsEndpoint', DEFAULT_EMBEDDINGS_ENDPOINT),
        embeddingModel: readStringSetting(configuration, 'embeddingModel', DEFAULT_EMBEDDING_MODEL),
        embeddingDimensions: readNumberSetting(configuration, 'embeddingDimensions', DEFAULT_EMBEDDING_DIMENSIONS, 1),
        cohereApiKey: configuredCohereApiKey || environmentCohereApiKey,
        cohereRerankModel: readStringSetting(configuration, 'cohereRerankModel', DEFAULT_COHERE_RERANK_MODEL),
        maxTokensPerChunk: readNumberSetting(configuration, 'maxTokensPerChunk', DEFAULT_MAX_TOKENS_PER_CHUNK, 1),
        chunkOverlapTokens: readNumberSetting(configuration, 'chunkOverlapTokens', DEFAULT_CHUNK_OVERLAP_TOKENS, 0),
    };
}
function resolveCohereApiKey(configuredToken) {
    const token = configuredToken.trim();
    if (!token || token === 'PUT_YOUR_COHERE_API_KEY_HERE') {
        throw new Error('Falta configurar COHERE_API_KEY para aplicar reranking con cross-encoder.');
    }
    return token;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function findFirstValueByKey(value, key) {
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findFirstValueByKey(item, key);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    if (Object.prototype.hasOwnProperty.call(value, key)) {
        return value[key];
    }
    for (const nested of Object.values(value)) {
        const found = findFirstValueByKey(nested, key);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
}
function findPromptByPattern(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const keyPath = value.k;
    if (Array.isArray(keyPath) &&
        keyPath.length === 2 &&
        keyPath[0] === 'inputState' &&
        keyPath[1] === 'inputText') {
        return value.v;
    }
    return undefined;
}
function findCustomTitleByPattern(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const keyPath = value.k;
    const fieldValue = value.v;
    if (Array.isArray(keyPath) &&
        keyPath.length === 1 &&
        keyPath[0] === 'customTitle' &&
        typeof fieldValue === 'string' &&
        fieldValue.trim().length > 0) {
        return fieldValue.trim();
    }
    return undefined;
}
function stringifyUnknown(value) {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
function timestampToDateTime(unixTimestamp) {
    if (typeof unixTimestamp !== 'number' && typeof unixTimestamp !== 'string') {
        return 'sin fecha';
    }
    const numeric = Number(unixTimestamp);
    if (!Number.isFinite(numeric)) {
        return 'sin fecha';
    }
    const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) {
        return 'sin fecha';
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
function validateJsonlPath(inputPath) {
    if (!path.isAbsolute(inputPath)) {
        throw new Error('Debes pasar una ruta absoluta a un fichero .jsonl');
    }
    if (path.extname(inputPath).toLowerCase() !== '.jsonl') {
        throw new Error('El fichero de entrada debe tener extension .jsonl');
    }
}
function buildMarkdownContent(title, conversation) {
    const lines = [];
    lines.push(`# ${title}`);
    lines.push('');
    lines.push('## Conversacion');
    lines.push('');
    if (conversation.length === 0) {
        lines.push('(Sin mensajes encontrados)');
        lines.push('');
    }
    else {
        conversation.forEach((entry, index) => {
            lines.push(`### ${index + 1}. ${entry.role} (${entry.timestamp})`);
            lines.push('');
            lines.push(entry.content || '(vacio)');
            lines.push('');
        });
    }
    return `${lines.join('\n')}\n`;
}
function resolveMarkdownTempDirectory() {
    if (process.platform === 'win32') {
        return path.join(os.homedir(), 'AppData', 'Local', 'Temp');
    }
    return os.tmpdir();
}
function sanitizeSegment(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
function buildTempMarkdownName(jsonlAbsolutePath, storageFolder) {
    const baseName = path.basename(jsonlAbsolutePath, '.jsonl');
    const storageTag = sanitizeSegment(path.basename(storageFolder));
    return `${storageTag}-${sanitizeSegment(baseName)}.md`;
}
async function convertJsonlToMarkdownInTemp(inputPath, storageFolder) {
    validateJsonlPath(inputPath);
    const rawContent = await fs.readFile(inputPath, 'utf8');
    const rawLines = rawContent.split(/\r?\n/);
    let sessionTitle = path.basename(inputPath, '.jsonl');
    const conversation = [];
    for (let index = 0; index < rawLines.length; index += 1) {
        const trimmed = rawLines[index].trim();
        if (!trimmed) {
            continue;
        }
        let parsedLine;
        try {
            parsedLine = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const customTitle = findCustomTitleByPattern(parsedLine);
        if (customTitle) {
            sessionTitle = customTitle;
        }
        const timestampValue = findFirstValueByKey(parsedLine, 'timestamp');
        const timestamp = timestampToDateTime(timestampValue);
        const promptValue = findPromptByPattern(parsedLine);
        const prompt = stringifyUnknown(promptValue);
        if (prompt) {
            conversation.push({
                role: 'Usuario',
                timestamp,
                content: prompt,
            });
        }
        const responseValue = findFirstValueByKey(parsedLine, 'response');
        const responseText = stringifyUnknown(responseValue);
        if (responseText) {
            conversation.push({
                role: 'IA',
                timestamp,
                content: responseText,
            });
        }
    }
    const markdown = buildMarkdownContent(sessionTitle, conversation);
    const outputDirectory = resolveMarkdownTempDirectory();
    await fs.mkdir(outputDirectory, { recursive: true });
    const outputPath = path.join(outputDirectory, buildTempMarkdownName(inputPath, storageFolder));
    await fs.writeFile(outputPath, markdown, 'utf8');
    return outputPath;
}
function tokenizeByWhitespace(text) {
    return text.trim().split(/\s+/).filter((token) => token.length > 0);
}
function splitLongSentenceIntoChunks(tokens, maxTokens, overlap) {
    const chunks = [];
    const safeMaxTokens = Math.max(maxTokens, 1);
    const safeOverlap = Math.min(Math.max(overlap, 0), safeMaxTokens - 1);
    const step = Math.max(safeMaxTokens - safeOverlap, 1);
    for (let start = 0; start < tokens.length; start += step) {
        const chunkTokens = tokens.slice(start, start + safeMaxTokens);
        if (chunkTokens.length === 0) {
            continue;
        }
        chunks.push(chunkTokens.join(' '));
    }
    return chunks;
}
function getOverlapText(sentences, overlap) {
    if (overlap <= 0 || sentences.length === 0) {
        return '';
    }
    const combined = sentences.join(' ').trim();
    const tokens = tokenizeByWhitespace(combined);
    if (tokens.length === 0) {
        return '';
    }
    const overlapTokens = tokens.slice(-Math.min(overlap, tokens.length));
    return overlapTokens.join(' ');
}
function chunkText(text, maxTokens = 400, overlap = 50) {
    const normalizedText = text.trim();
    if (!normalizedText) {
        return [];
    }
    const sentences = normalizedText.split(/(?<=[.!?])\s+/);
    const chunks = [];
    let currentChunkSentences = [];
    let currentTokenCount = 0;
    for (const sentence of sentences) {
        const sentenceTokens = tokenizeByWhitespace(sentence);
        const sentenceTokenCount = sentenceTokens.length;
        if (sentenceTokenCount === 0) {
            continue;
        }
        if (currentTokenCount + sentenceTokenCount > maxTokens && currentChunkSentences.length > 0) {
            const chunkTextValue = currentChunkSentences.join(' ').trim();
            if (chunkTextValue) {
                chunks.push(chunkTextValue);
            }
            const overlapText = getOverlapText(currentChunkSentences, overlap);
            currentChunkSentences = overlapText ? [overlapText] : [];
            currentTokenCount = overlapText ? tokenizeByWhitespace(overlapText).length : 0;
        }
        if (sentenceTokenCount > maxTokens) {
            const sentenceChunks = splitLongSentenceIntoChunks(sentenceTokens, maxTokens, overlap);
            for (const sentenceChunk of sentenceChunks) {
                chunks.push(sentenceChunk);
            }
            currentChunkSentences = [];
            currentTokenCount = 0;
            continue;
        }
        currentChunkSentences.push(sentence);
        currentTokenCount += sentenceTokenCount;
    }
    if (currentChunkSentences.length > 0) {
        const tailChunk = currentChunkSentences.join(' ').trim();
        if (tailChunk) {
            chunks.push(tailChunk);
        }
    }
    return chunks;
}
function computeWeightedFinalScore(vectorScore, rerankScore, vectorWeight, rerankWeight) {
    const totalWeight = vectorWeight + rerankWeight;
    if (totalWeight <= 0) {
        return (vectorScore + rerankScore) / 2;
    }
    return (vectorScore * vectorWeight + rerankScore * rerankWeight) / totalWeight;
}
function extractRerankScores(payload, candidateCount) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('La respuesta de reranking no es un JSON valido.');
    }
    const response = payload;
    const rawItems = Array.isArray(response.data)
        ? response.data
        : Array.isArray(response.results)
            ? response.results
            : null;
    if (!rawItems || rawItems.length === 0) {
        throw new Error('La respuesta de reranking no incluye resultados.');
    }
    const scores = new Array(candidateCount).fill(Number.NEGATIVE_INFINITY);
    for (const rawItem of rawItems) {
        if (!rawItem || typeof rawItem !== 'object') {
            continue;
        }
        const item = rawItem;
        const indexValue = item.index ?? item.document_index;
        const scoreValue = item.relevanceScore ?? item.relevance_score ?? item.score;
        const index = Number(indexValue);
        const score = Number(scoreValue);
        if (!Number.isInteger(index) || index < 0 || index >= candidateCount) {
            continue;
        }
        if (!Number.isFinite(score)) {
            continue;
        }
        scores[index] = score;
    }
    for (let i = 0; i < scores.length; i += 1) {
        if (!Number.isFinite(scores[i])) {
            scores[i] = 0;
        }
    }
    return scores;
}
function mapVectorResultsToFinal(results) {
    return results
        .map((result) => ({
        ...result,
        vectorScore: result.score,
        rerankScore: 0,
        finalScore: result.score,
        mode: 'vector-only',
    }))
        .sort((left, right) => right.finalScore - left.finalScore);
}
async function rerankVectorSearchResults(queryText, candidates, cohereApiKey, cohereRerankModel, limit) {
    if (candidates.length === 0) {
        return [];
    }
    const cappedLimit = Math.min(Math.max(limit, 1), candidates.length);
    const rerankRequestPayload = {
        model: cohereRerankModel,
        query: queryText,
        documents: candidates.map((item) => item.chunkText),
        topN: cappedLimit,
    };
    console.log('[historico] Peticion enviada a Cohere API REST (SDK) para reranking:');
    console.log(JSON.stringify(rerankRequestPayload, null, 2));
    const cohereClient = new Cohere.CohereClientV2({ token: cohereApiKey });
    const rerankResponse = await cohereClient.rerank(rerankRequestPayload);
    console.log('[historico] Respuesta cruda de Cohere API REST (reranking):');
    console.log(JSON.stringify(rerankResponse, null, 2));
    const rerankScores = extractRerankScores(rerankResponse, candidates.length);
    return candidates
        .map((candidate, index) => {
        const vectorScore = candidate.score;
        const rerankScore = rerankScores[index] ?? 0;
        const finalScore = computeWeightedFinalScore(vectorScore, rerankScore, DEFAULT_VECTOR_SCORE_WEIGHT, DEFAULT_RERANK_SCORE_WEIGHT);
        return {
            ...candidate,
            vectorScore,
            rerankScore,
            finalScore,
            mode: 'hybrid',
        };
    })
        .filter((item) => Number.isFinite(item.finalScore))
        .sort((left, right) => right.finalScore - left.finalScore)
        .slice(0, cappedLimit);
}
async function parseResponsePayload(response) {
    const text = await response.text();
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function extractEmbeddingVector(payload, expectedDimensions) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('La respuesta de embeddings no es un JSON valido.');
    }
    const response = payload;
    let rawVector;
    if (Array.isArray(response.embedding)) {
        rawVector = response.embedding;
    }
    else if (Array.isArray(response.embeddings) && response.embeddings.length > 0) {
        rawVector = response.embeddings[0];
    }
    else if (Array.isArray(response.data) && response.data.length > 0) {
        const firstDatum = response.data[0];
        rawVector = firstDatum.embedding;
    }
    if (!Array.isArray(rawVector)) {
        throw new Error('La respuesta no incluye un vector embedding valido.');
    }
    const vector = rawVector.map((value) => Number(value));
    if (vector.some((value) => Number.isNaN(value))) {
        throw new Error('El vector embedding contiene valores no numericos.');
    }
    if (vector.length !== expectedDimensions) {
        throw new Error(`Se esperaba un embedding de ${expectedDimensions} dimensiones y se recibio ${vector.length}.`);
    }
    return vector;
}
async function requestEmbedding(input, runtimeConfiguration) {
    const response = await fetch(runtimeConfiguration.embeddingsEndpoint, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: runtimeConfiguration.embeddingModel,
            prompt: input,
        }),
    });
    const payload = await parseResponsePayload(response);
    if (!response.ok) {
        const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
        throw new Error(`Error HTTP ${response.status} ${response.statusText}: ${detail}`);
    }
    return extractEmbeddingVector(payload, runtimeConfiguration.embeddingDimensions);
}
function summarizeChunk(text, maxLength = 140) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength)}...`;
}
function logDetectedJsonlFiles(title, jsonlFiles) {
    console.log(`[historico] ${title} (${jsonlFiles.length})`);
    if (jsonlFiles.length === 0) {
        console.log('[historico] - ninguno');
        return;
    }
    for (const item of jsonlFiles) {
        console.log(`[historico] - ${item.jsonlAbsolutePath}`);
    }
}
function logReindexedFiles(title, files) {
    console.log(`[historico] ${title} (${files.length})`);
    if (files.length === 0) {
        console.log('[historico] - ninguno');
        return;
    }
    for (const item of files) {
        console.log(`[historico] - ${item.jsonlAbsolutePath} | chunks=${item.chunks.length} | md=${item.mdAbsolutePath}`);
    }
}
function logVectorSearchResultsInConsole(results) {
    console.log(`[historico] Resultados de busqueda vectorial ordenados por score (${results.length})`);
    if (results.length === 0) {
        console.log('[historico] - sin coincidencias vectoriales');
        return;
    }
    for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        console.log(`[historico] #${index + 1} score=${result.score.toFixed(6)} | chunk=${result.chunkIndex} | ${result.jsonlAbsolutePath} | ${summarizeChunk(result.chunkText)}`);
    }
}
function logHybridRankingResultsInConsole(results) {
    console.log(`[historico] Resultados finales ordenados por final_score (${results.length})`);
    if (results.length === 0) {
        console.log('[historico] - sin resultados finales para reranking');
        return;
    }
    for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        console.log(`[historico] #${index + 1} final_score=${result.finalScore.toFixed(6)}, vector_score=${result.vectorScore.toFixed(6)}, rerank_score=${result.rerankScore.toFixed(6)}, mode=${result.mode} | chunk=${result.chunkIndex} | ${result.jsonlAbsolutePath}`);
    }
}
async function collectChatSessionJsonlFiles(candidateFolder) {
    const chatSessionsFolder = path.join(candidateFolder, 'chatSessions');
    let chatSessionsEntries;
    try {
        chatSessionsEntries = await fs.readdir(chatSessionsFolder, { withFileTypes: true });
    }
    catch (error) {
        const nodeError = error;
        if (nodeError.code === 'ENOENT') {
            console.log(`[historico] La carpeta chatSessions no existe en: ${candidateFolder}`);
            return [];
        }
        console.warn(`[historico] No se pudo leer la carpeta chatSessions en ${candidateFolder}: ${nodeError.message}`);
        return [];
    }
    const jsonlFiles = chatSessionsEntries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'));
    if (jsonlFiles.length === 0) {
        console.log(`[historico] No hay archivos .jsonl en: ${chatSessionsFolder}`);
        return [];
    }
    const detected = await Promise.all(jsonlFiles.map(async (jsonlFile) => {
        const jsonlAbsolutePath = path.join(chatSessionsFolder, jsonlFile.name);
        try {
            const stat = await fs.stat(jsonlAbsolutePath);
            return {
                storageFolder: candidateFolder,
                sessionFile: jsonlFile.name,
                jsonlAbsolutePath,
                jsonlLastModifiedMs: Math.trunc(stat.mtimeMs),
            };
        }
        catch (error) {
            const nodeError = error;
            console.warn(`[historico] No se pudo leer metadata de ${jsonlAbsolutePath}: ${nodeError.message}`);
            return undefined;
        }
    }));
    return detected.filter((item) => Boolean(item));
}
async function findMatchingWorkspaceStorageFolders(currentWorkspacePath) {
    const directoryEntries = await fs.readdir(WORKSPACE_STORAGE_PATH, { withFileTypes: true });
    const matches = [];
    const normalizedWorkspaceUri = workspacePathToStorageUri(currentWorkspacePath);
    await Promise.all(directoryEntries.map(async (entry) => {
        if (!entry.isDirectory()) {
            return;
        }
        const candidateFolder = path.join(WORKSPACE_STORAGE_PATH, entry.name);
        const workspaceJsonPath = path.join(candidateFolder, 'workspace.json');
        try {
            const workspaceJsonContent = await fs.readFile(workspaceJsonPath, 'utf8');
            let containsCurrentWorkspacePath = false;
            try {
                const parsedWorkspaceJson = JSON.parse(workspaceJsonContent);
                containsCurrentWorkspacePath = jsonContainsExactNormalizedPath(parsedWorkspaceJson, normalizedWorkspaceUri);
            }
            catch {
                containsCurrentWorkspacePath = normalizePathForSearch(workspaceJsonContent).includes(normalizedWorkspaceUri);
            }
            if (containsCurrentWorkspacePath) {
                matches.push(candidateFolder);
            }
        }
        catch (error) {
            const nodeError = error;
            if (nodeError.code && nodeError.code !== 'ENOENT') {
                console.warn(`[historico] No se pudo leer ${workspaceJsonPath}: ${nodeError.message}`);
            }
        }
    }));
    return matches.sort();
}
function buildModelContextFromDetectedPaths(detectedFiles) {
    if (detectedFiles.length === 0) {
        return 'No se detectaron rutas absolutas de ficheros JSONL.';
    }
    const maxPaths = 15;
    const lines = detectedFiles
        .slice(0, maxPaths)
        .map((item) => `- ${item.jsonlAbsolutePath}`)
        .join('\n');
    const overflowCount = Math.max(0, detectedFiles.length - maxPaths);
    const overflowLine = overflowCount > 0 ? `\n- ... y ${overflowCount} ruta(s) mas` : '';
    return `Rutas JSONL detectadas (${detectedFiles.length}):\n${lines}${overflowLine}`;
}
function buildVectorSearchContext(results) {
    if (results.length === 0) {
        return 'No hubo coincidencias en la busqueda vectorial para el prompt recibido.';
    }
    const lines = results.map((result, index) => (`- #${index + 1} (score=${result.score.toFixed(6)}): ${result.jsonlAbsolutePath} | chunk=${result.chunkIndex} | ${summarizeChunk(result.chunkText, 180)}`));
    return `Resultados de busqueda vectorial por chunks (${results.length}):\n${lines.join('\n')}`;
}
function buildHybridRankingContext(results) {
    if (results.length === 0) {
        return 'No hubo resultados finales tras aplicar reranking.';
    }
    const lines = results.map((result, index) => (`- #${index + 1} (final=${result.finalScore.toFixed(6)}, vector=${result.vectorScore.toFixed(6)}, rerank=${result.rerankScore.toFixed(6)}, mode=${result.mode}): ${result.jsonlAbsolutePath} | chunk=${result.chunkIndex}`));
    return `Resultados finales con score hibrido (${results.length}):\n${lines.join('\n')}`;
}
function isDefaultModelFamily(model) {
    return model.family.toLowerCase() === DEFAULT_MODEL_FAMILY;
}
function pickDefaultCopilotModel(models) {
    const gpt41Model = models.find((model) => isDefaultModelFamily(model));
    if (gpt41Model) {
        return gpt41Model;
    }
    return models[0];
}
async function getAvailableCopilotModels() {
    return vscode.lm.selectChatModels(ALL_COPILOT_MODELS_SELECTOR);
}
async function resolveModelWithDefaultPreference(context, requestModel) {
    try {
        const copilotModels = await getAvailableCopilotModels();
        if (copilotModels.length === 0) {
            return requestModel;
        }
        const selectedModelId = context.globalState.get(MODEL_GLOBAL_STATE_KEY);
        if (selectedModelId) {
            const selectedModel = copilotModels.find((model) => model.id === selectedModelId);
            if (selectedModel) {
                return selectedModel;
            }
            console.warn(`[historico] El modelo guardado ya no esta disponible: ${selectedModelId}`);
        }
        const defaultModel = pickDefaultCopilotModel(copilotModels);
        if (defaultModel) {
            return defaultModel;
        }
    }
    catch (error) {
        console.warn('[historico] No se pudo seleccionar modelo Copilot configurado:', error);
    }
    return requestModel;
}
function formatModelDescription(model) {
    const parts = [model.family];
    if (model.version) {
        parts.push(model.version);
    }
    if (isDefaultModelFamily(model)) {
        parts.push('default: GPT-4.1');
    }
    return parts.join(' | ');
}
async function selectParticipantModel(context) {
    let copilotModels;
    try {
        copilotModels = await getAvailableCopilotModels();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`No se pudieron obtener modelos de GitHub Copilot: ${message}`);
        return;
    }
    if (copilotModels.length === 0) {
        vscode.window.showWarningMessage('No hay modelos de GitHub Copilot disponibles para seleccionar.');
        return;
    }
    const defaultModel = pickDefaultCopilotModel(copilotModels);
    if (!defaultModel) {
        vscode.window.showWarningMessage('No se encontro un modelo por defecto para el participante.');
        return;
    }
    const selectedModelId = context.globalState.get(MODEL_GLOBAL_STATE_KEY);
    const activeModelId = selectedModelId ?? defaultModel.id;
    const quickPickItems = copilotModels
        .map((model) => ({
        label: model.name,
        description: formatModelDescription(model),
        detail: model.id,
        picked: model.id === activeModelId,
        model,
    }))
        .sort((left, right) => {
        if (left.model.id === defaultModel.id) {
            return -1;
        }
        if (right.model.id === defaultModel.id) {
            return 1;
        }
        return left.label.localeCompare(right.label);
    });
    const picked = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: 'Selecciona el modelo de GitHub Copilot para @historico (predeterminado: GPT-4.1).',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!picked) {
        return;
    }
    await context.globalState.update(MODEL_GLOBAL_STATE_KEY, picked.model.id);
    vscode.window.showInformationMessage(`@historico usara el modelo: ${picked.model.name}`);
}
async function answerInvocationPrompt(context, request, response, token, processingContext) {
    const model = await resolveModelWithDefaultPreference(context, request.model);
    const promptToAnswer = request.prompt.trim().length > 0
        ? request.prompt.trim()
        : 'Explica brevemente el resultado del procesamiento realizado por @historico.';
    response.progress(`Respondiendo al prompt con el modelo: ${model.name}`);
    const llmPrompt = [
        'Eres el participante @historico de una extension de VS Code.',
        'Responde en espanol de forma clara y util usando el contexto disponible.',
        '',
        'Contexto del procesamiento ya ejecutado:',
        processingContext,
        '',
        `Prompt del usuario: ${promptToAnswer}`,
    ].join('\n');
    try {
        const llmResponse = await model.sendRequest([vscode.LanguageModelChatMessage.User(llmPrompt)], undefined, token);
        response.markdown('\n\n---\n\n**Respuesta al prompt**\n\n');
        for await (const chunk of llmResponse.text) {
            response.markdown(chunk);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.markdown(`\n\nNo se pudo generar respuesta con el modelo: ${message}`);
        console.error('[historico] Error al responder el prompt con el modelo:', error);
    }
}
function toJsonlWorkspaceRecord(currentWorkspacePath, file, mdAbsolutePath) {
    return {
        workspacePath: currentWorkspacePath,
        storageFolder: file.storageFolder,
        sessionFile: file.sessionFile,
        jsonlAbsolutePath: file.jsonlAbsolutePath,
        mdAbsolutePath,
        jsonlLastModifiedMs: file.jsonlLastModifiedMs,
    };
}
function sumChunkCounts(records) {
    let total = 0;
    for (const record of records) {
        total += record.chunks.length;
    }
    return total;
}
function activate(context) {
    const helloWorldCommand = vscode.commands.registerCommand('recuperar-historico-copilot.helloWorld', () => {
        vscode.window.showInformationMessage('Participante de chat @historico listo para leer sesiones previas.');
    });
    const selectModelCommand = vscode.commands.registerCommand(SELECT_MODEL_COMMAND_ID, async () => {
        await selectParticipantModel(context);
    });
    const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, async (request, _chatContext, response, token) => {
        const currentWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const runtimeConfiguration = resolveRuntimeConfiguration();
        let processingOutcome;
        if (!currentWorkspacePath) {
            processingOutcome = {
                statusMessage: 'No hay un workspace abierto para comparar rutas.',
                contextForModel: 'No habia workspace abierto al invocar el participante.',
            };
            response.markdown(processingOutcome.statusMessage);
            console.warn('[historico] No se encontro un workspace abierto.');
            await answerInvocationPrompt(context, request, response, token, processingOutcome.contextForModel);
            return;
        }
        response.progress('Buscando coincidencias en workspaceStorage...');
        let matchingFolders;
        try {
            matchingFolders = await findMatchingWorkspaceStorageFolders(currentWorkspacePath);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            processingOutcome = {
                statusMessage: `Error al buscar en workspaceStorage: ${message}`,
                contextForModel: `Fallo en busqueda de workspaceStorage para ${currentWorkspacePath}: ${message}`,
            };
            response.markdown(processingOutcome.statusMessage);
            console.error('[historico] Error escaneando workspaceStorage:', error);
            await answerInvocationPrompt(context, request, response, token, processingOutcome.contextForModel);
            return;
        }
        console.log(`[historico] Workspace actual: ${currentWorkspacePath} y matchingFolders encontrados: ${matchingFolders.length}`);
        if (matchingFolders.length === 0) {
            processingOutcome = {
                statusMessage: 'No se encontraron carpetas coincidentes en workspaceStorage.',
                contextForModel: `No hubo coincidencias de workspaceStorage para ${currentWorkspacePath}.`,
            };
            response.markdown(processingOutcome.statusMessage);
            await answerInvocationPrompt(context, request, response, token, processingOutcome.contextForModel);
            return;
        }
        response.progress('Recolectando rutas absolutas de ficheros JSONL...');
        const detectedByFolder = await Promise.all(matchingFolders.map((folder) => collectChatSessionJsonlFiles(folder)));
        const detectedFiles = detectedByFolder.flat();
        logDetectedJsonlFiles('Rutas JSONL detectadas', detectedFiles);
        if (detectedFiles.length === 0) {
            processingOutcome = {
                statusMessage: 'Se encontraron carpetas coincidentes, pero no ficheros JSONL.',
                contextForModel: `Se encontraron ${matchingFolders.length} carpeta(s) coincidente(s), pero sin JSONL.`,
            };
            response.markdown(processingOutcome.statusMessage);
            await answerInvocationPrompt(context, request, response, token, processingOutcome.contextForModel);
            return;
        }
        const dbFilePath = path.join(context.globalStorageUri.fsPath, DATABASE_FILE_NAME);
        const promptForVectorSearch = request.prompt.trim();
        const filesByKey = new Map();
        for (const file of detectedFiles) {
            filesByKey.set(buildJsonlFileKey(file.jsonlAbsolutePath), file);
        }
        const deduplicatedFiles = Array.from(filesByKey.values());
        let database;
        try {
            database = await sessionDatabase_1.SessionDatabase.create(dbFilePath);
            const storedFiles = await database.getJsonlFilesByWorkspace(currentWorkspacePath);
            const storedByKey = new Map();
            for (const item of storedFiles) {
                storedByKey.set(buildJsonlFileKey(item.jsonlAbsolutePath), item);
            }
            await database.deleteFilesMissingFromWorkspace(currentWorkspacePath, deduplicatedFiles.map((file) => file.jsonlAbsolutePath));
            const filesToReindex = [];
            const alreadyIndexedFiles = [];
            for (const file of deduplicatedFiles) {
                const key = buildJsonlFileKey(file.jsonlAbsolutePath);
                const existing = storedByKey.get(key);
                if (existing &&
                    existing.jsonlLastModifiedMs === file.jsonlLastModifiedMs &&
                    existing.storageFolder === file.storageFolder &&
                    existing.sessionFile === file.sessionFile) {
                    alreadyIndexedFiles.push(existing);
                }
                else {
                    filesToReindex.push(file);
                }
            }
            const reindexedFiles = [];
            const failedFiles = [];
            for (let fileIndex = 0; fileIndex < filesToReindex.length; fileIndex += 1) {
                const file = filesToReindex[fileIndex];
                response.progress(`Convirtiendo JSONL a MD (${fileIndex + 1}/${filesToReindex.length}): ${file.sessionFile}`);
                try {
                    const mdAbsolutePath = await convertJsonlToMarkdownInTemp(file.jsonlAbsolutePath, file.storageFolder);
                    const markdownContent = await fs.readFile(mdAbsolutePath, 'utf8');
                    const chunks = chunkText(markdownContent, runtimeConfiguration.maxTokensPerChunk, runtimeConfiguration.chunkOverlapTokens);
                    const chunkRecords = [];
                    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
                        response.progress(`Embedding chunk ${chunkIndex + 1}/${chunks.length} del fichero ${file.sessionFile}`);
                        const chunkEmbedding = await requestEmbedding(chunks[chunkIndex], runtimeConfiguration);
                        chunkRecords.push({
                            chunkIndex,
                            chunkText: chunks[chunkIndex],
                            chunkEmbedding,
                        });
                    }
                    const fileRecord = toJsonlWorkspaceRecord(currentWorkspacePath, file, mdAbsolutePath);
                    const recordToStore = {
                        ...fileRecord,
                        chunks: chunkRecords,
                    };
                    await database.upsertJsonlFileWithChunks(recordToStore);
                    reindexedFiles.push(recordToStore);
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    failedFiles.push({
                        jsonlAbsolutePath: file.jsonlAbsolutePath,
                        reason,
                    });
                    console.warn(`[historico] No se pudo procesar ${file.jsonlAbsolutePath}: ${reason}`);
                }
            }
            logReindexedFiles('Ficheros reindexados', reindexedFiles);
            let vectorSearchResults = [];
            let hybridRankedResults = [];
            if (promptForVectorSearch.length > 0) {
                response.progress('Generando embedding del prompt para busqueda vectorial...');
                const promptEmbedding = await requestEmbedding(promptForVectorSearch, runtimeConfiguration);
                vectorSearchResults = await database.searchSimilarChunksByEmbedding(currentWorkspacePath, promptEmbedding, DEFAULT_VECTOR_RESULTS_LIMIT);
                logVectorSearchResultsInConsole(vectorSearchResults);
                if (vectorSearchResults.length > 0) {
                    response.progress('Aplicando reranking con cross-encoder (Cohere)...');
                    try {
                        const cohereApiKey = resolveCohereApiKey(runtimeConfiguration.cohereApiKey);
                        hybridRankedResults = await rerankVectorSearchResults(promptForVectorSearch, vectorSearchResults, cohereApiKey, runtimeConfiguration.cohereRerankModel, DEFAULT_RERANK_RESULTS_LIMIT);
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.warn(`[historico] No se pudo aplicar reranking con Cohere API REST. Se usa ranking vectorial: ${message}`);
                        hybridRankedResults = mapVectorResultsToFinal(vectorSearchResults);
                    }
                    logHybridRankingResultsInConsole(hybridRankedResults);
                }
            }
            const totalChunksIndexed = sumChunkCounts(reindexedFiles);
            processingOutcome = {
                statusMessage: `Se detectaron ${deduplicatedFiles.length} rutas JSONL absolutas. ` +
                    `${alreadyIndexedFiles.length} fichero(s) ya estaban indexados y ${reindexedFiles.length} se reindexaron tras convertir JSONL a MD en ${resolveMarkdownTempDirectory()}. ` +
                    `Se almacenaron ${totalChunksIndexed} chunk(s) con embedding en better-sqlite3. ` +
                    `Errores de procesamiento: ${failedFiles.length}. ` +
                    `Busqueda vectorial: ${vectorSearchResults.length} coincidencia(s). ` +
                    `Reranking final: ${hybridRankedResults.length} resultado(s).`,
                contextForModel: [
                    `Workspace: ${currentWorkspacePath}`,
                    `Configuracion activa de embeddings endpoint: ${runtimeConfiguration.embeddingsEndpoint}`,
                    `Configuracion activa de embeddings model: ${runtimeConfiguration.embeddingModel}`,
                    `Configuracion activa de embedding dimensions: ${runtimeConfiguration.embeddingDimensions}`,
                    `Configuracion activa de cohere rerank model: ${runtimeConfiguration.cohereRerankModel}`,
                    `Configuracion activa de maxTokensPerChunk: ${runtimeConfiguration.maxTokensPerChunk}`,
                    `Configuracion activa de chunkOverlapTokens: ${runtimeConfiguration.chunkOverlapTokens}`,
                    `Configuracion activa de cohere api key: ${runtimeConfiguration.cohereApiKey ? '[configurada]' : '[no configurada]'}`,
                    `Carpetas coincidentes: ${matchingFolders.length}`,
                    `Rutas JSONL detectadas: ${deduplicatedFiles.length}`,
                    `Ficheros ya indexados: ${alreadyIndexedFiles.length}`,
                    `Ficheros reindexados: ${reindexedFiles.length}`,
                    `Chunks nuevos indexados: ${totalChunksIndexed}`,
                    `Directorio temporal MD: ${resolveMarkdownTempDirectory()}`,
                    `Errores de procesamiento: ${failedFiles.length}`,
                    ...(failedFiles.map((item) => `- ${item.jsonlAbsolutePath}: ${item.reason}`)),
                    `Prompt para busqueda vectorial: ${promptForVectorSearch.length > 0 ? promptForVectorSearch : '[vacio]'}`,
                    `Resultados vectoriales: ${vectorSearchResults.length}`,
                    `Resultados finales tras reranking: ${hybridRankedResults.length}`,
                    buildVectorSearchContext(vectorSearchResults),
                    buildHybridRankingContext(hybridRankedResults),
                    buildModelContextFromDetectedPaths(deduplicatedFiles),
                ].join('\n'),
            };
            response.markdown(processingOutcome.statusMessage);
            await answerInvocationPrompt(context, request, response, token, processingOutcome.contextForModel);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            processingOutcome = {
                statusMessage: `Error trabajando con better-sqlite3: ${message}`,
                contextForModel: `Fallo al guardar sesiones para ${currentWorkspacePath}: ${message}`,
            };
            response.markdown(processingOutcome.statusMessage);
            console.error('[historico] Error guardando sesiones en better-sqlite3:', error);
            await answerInvocationPrompt(context, request, response, token, processingOutcome.contextForModel);
        }
        finally {
            if (database) {
                await database.close();
            }
        }
    });
    context.subscriptions.push(helloWorldCommand);
    context.subscriptions.push(selectModelCommand);
    context.subscriptions.push(participant);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map