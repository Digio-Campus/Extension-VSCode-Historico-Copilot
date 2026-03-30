import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import BetterSqlite3 = require('better-sqlite3');

type SqliteDatabase = ReturnType<typeof BetterSqlite3>;

export interface WorkspaceJsonlFileRecord {
	workspacePath: string;
	storageFolder: string;
	sessionFile: string;
	jsonlAbsolutePath: string;
	mdAbsolutePath: string;
	jsonlLastModifiedMs: number;
}

export interface ChunkEmbeddingRecord {
	chunkIndex: number;
	chunkText: string;
	chunkEmbedding: number[];
}

export interface JsonlFileWithChunksRecord extends WorkspaceJsonlFileRecord {
	chunks: ChunkEmbeddingRecord[];
}

export interface SimilarChunkRecord extends WorkspaceJsonlFileRecord, ChunkEmbeddingRecord {
	score: number;
}

interface RawWorkspaceJsonlFileRecord {
	workspacePath: string;
	storageFolder: string;
	sessionFile: string;
	jsonlAbsolutePath: string;
	mdAbsolutePath: string;
	jsonlLastModifiedMs: number;
}

interface RawSimilarChunkRecord extends RawWorkspaceJsonlFileRecord {
	chunkIndex: number;
	chunkText: string;
	chunkEmbeddingJson: string;
	score: number;
}

function parseEmbeddingVector(rawValue: string): number[] {
	try {
		const parsed = JSON.parse(rawValue) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}

		const vector = parsed.map((value) => Number(value));
		if (vector.some((value) => !Number.isFinite(value))) {
			return [];
		}

		return vector;
	} catch {
		return [];
	}
}

function openDatabase(dbFilePath: string): SqliteDatabase {
	const db = new BetterSqlite3(dbFilePath);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	return db;
}

function run(db: SqliteDatabase, sql: string, params: unknown[] = []): void {
	db.prepare(sql).run(...params);
}

function all<T>(db: SqliteDatabase, sql: string, params: unknown[] = []): T[] {
	return db.prepare(sql).all(...params) as T[];
}

function closeDatabase(db: SqliteDatabase): void {
	db.close();
}

export class SessionDatabase {
	private constructor(private readonly db: SqliteDatabase) {}

	public static async create(dbFilePath: string): Promise<SessionDatabase> {
		await fs.mkdir(path.dirname(dbFilePath), { recursive: true });
		const db = openDatabase(dbFilePath);
		const instance = new SessionDatabase(db);
		await instance.initialize();
		return instance;
	}

	private async initialize(): Promise<void> {
		run(this.db, `
			CREATE TABLE IF NOT EXISTS workspace_jsonl_files (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				workspace_path TEXT NOT NULL,
				storage_folder TEXT NOT NULL,
				session_file TEXT NOT NULL,
				jsonl_absolute_path TEXT NOT NULL,
				md_absolute_path TEXT NOT NULL,
				jsonl_last_modified_ms INTEGER NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(workspace_path, jsonl_absolute_path)
			)
		`);

		run(this.db, `
			CREATE TABLE IF NOT EXISTS workspace_file_chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				workspace_file_id INTEGER NOT NULL,
				chunk_index INTEGER NOT NULL,
				chunk_text TEXT NOT NULL,
				chunk_embedding_json TEXT NOT NULL DEFAULT '[]',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(workspace_file_id, chunk_index),
				FOREIGN KEY (workspace_file_id) REFERENCES workspace_jsonl_files(id) ON DELETE CASCADE
			)
		`);

		run(this.db, `
			CREATE INDEX IF NOT EXISTS idx_workspace_jsonl_files_workspace
			ON workspace_jsonl_files(workspace_path)
		`);

		run(this.db, `
			CREATE INDEX IF NOT EXISTS idx_workspace_jsonl_files_jsonl_path
			ON workspace_jsonl_files(jsonl_absolute_path)
		`);

		run(this.db, `
			CREATE INDEX IF NOT EXISTS idx_workspace_file_chunks_workspace_file
			ON workspace_file_chunks(workspace_file_id)
		`);
	}

	public async getJsonlFilesByWorkspace(workspacePath: string): Promise<WorkspaceJsonlFileRecord[]> {
		const rows = all<RawWorkspaceJsonlFileRecord>(
			this.db,
			`SELECT workspace_path AS workspacePath,
					storage_folder AS storageFolder,
					session_file AS sessionFile,
					jsonl_absolute_path AS jsonlAbsolutePath,
					md_absolute_path AS mdAbsolutePath,
					jsonl_last_modified_ms AS jsonlLastModifiedMs
			 FROM workspace_jsonl_files
			 WHERE workspace_path = ?`,
			[workspacePath],
		);

		return rows.map((row) => ({
			workspacePath: row.workspacePath,
			storageFolder: row.storageFolder,
			sessionFile: row.sessionFile,
			jsonlAbsolutePath: row.jsonlAbsolutePath,
			mdAbsolutePath: row.mdAbsolutePath,
			jsonlLastModifiedMs: Number(row.jsonlLastModifiedMs),
		}));
	}

	public async deleteFilesMissingFromWorkspace(
		workspacePath: string,
		existingJsonlAbsolutePaths: string[],
	): Promise<void> {
		if (existingJsonlAbsolutePaths.length === 0) {
			run(this.db, 'DELETE FROM workspace_jsonl_files WHERE workspace_path = ?', [workspacePath]);
			return;
		}

		const placeholders = existingJsonlAbsolutePaths.map(() => '?').join(', ');
		const sql = `
			DELETE FROM workspace_jsonl_files
			WHERE workspace_path = ?
				AND jsonl_absolute_path NOT IN (${placeholders})
		`;

		run(this.db, sql, [workspacePath, ...existingJsonlAbsolutePaths]);
	}

	public async upsertJsonlFileWithChunks(record: JsonlFileWithChunksRecord): Promise<void> {
		const upsertFile = this.db.prepare(`
			INSERT INTO workspace_jsonl_files (
				workspace_path,
				storage_folder,
				session_file,
				jsonl_absolute_path,
				md_absolute_path,
				jsonl_last_modified_ms
			)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(workspace_path, jsonl_absolute_path)
			DO UPDATE SET
				storage_folder = excluded.storage_folder,
				session_file = excluded.session_file,
				md_absolute_path = excluded.md_absolute_path,
				jsonl_last_modified_ms = excluded.jsonl_last_modified_ms,
				updated_at = CURRENT_TIMESTAMP
		`);

		const getFileId = this.db.prepare(`
			SELECT id
			FROM workspace_jsonl_files
			WHERE workspace_path = ? AND jsonl_absolute_path = ?
		`);

		const deleteChunks = this.db.prepare('DELETE FROM workspace_file_chunks WHERE workspace_file_id = ?');
		const insertChunk = this.db.prepare(`
			INSERT INTO workspace_file_chunks (
				workspace_file_id,
				chunk_index,
				chunk_text,
				chunk_embedding_json
			)
			VALUES (?, ?, ?, ?)
		`);

		const transaction = this.db.transaction((item: JsonlFileWithChunksRecord) => {
			upsertFile.run(
				item.workspacePath,
				item.storageFolder,
				item.sessionFile,
				item.jsonlAbsolutePath,
				item.mdAbsolutePath,
				item.jsonlLastModifiedMs,
			);

			const rawFileRow = getFileId.get(item.workspacePath, item.jsonlAbsolutePath) as { id: number } | undefined;
			if (!rawFileRow) {
				throw new Error(`No se pudo recuperar el id del fichero ${item.jsonlAbsolutePath}`);
			}

			deleteChunks.run(rawFileRow.id);
			for (const chunk of item.chunks) {
				insertChunk.run(
					rawFileRow.id,
					chunk.chunkIndex,
					chunk.chunkText,
					JSON.stringify(chunk.chunkEmbedding),
				);
			}
		});

		transaction(record);
	}

	public async searchSimilarChunksByEmbedding(
		workspacePath: string,
		queryEmbedding: number[],
		limit: number,
	): Promise<SimilarChunkRecord[]> {
		if (queryEmbedding.length === 0) {
			return [];
		}

		const safeLimit = Math.max(1, limit);
		const queryEmbeddingJson = JSON.stringify(queryEmbedding);

		const rows = all<RawSimilarChunkRecord>(
			this.db,
			`WITH query_vector AS (
				SELECT
					CAST(key AS INTEGER) AS idx,
					CAST(value AS REAL) AS query_value
				FROM json_each(?)
			),
			candidate_chunks AS (
				SELECT
					f.workspace_path,
					f.storage_folder,
					f.session_file,
					f.jsonl_absolute_path,
					f.md_absolute_path,
					f.jsonl_last_modified_ms,
					c.chunk_index,
					c.chunk_text,
					c.chunk_embedding_json
				FROM workspace_jsonl_files AS f
				JOIN workspace_file_chunks AS c
					ON c.workspace_file_id = f.id
				WHERE f.workspace_path = ?
			),
			cosine_components AS (
				SELECT
					c.workspace_path AS workspacePath,
					c.storage_folder AS storageFolder,
					c.session_file AS sessionFile,
					c.jsonl_absolute_path AS jsonlAbsolutePath,
					c.md_absolute_path AS mdAbsolutePath,
					c.jsonl_last_modified_ms AS jsonlLastModifiedMs,
					c.chunk_index AS chunkIndex,
					c.chunk_text AS chunkText,
					c.chunk_embedding_json AS chunkEmbeddingJson,
					SUM(q.query_value * CAST(e.value AS REAL)) AS dot_product,
					SUM(q.query_value * q.query_value) AS query_norm_sq,
					SUM(CAST(e.value AS REAL) * CAST(e.value AS REAL)) AS candidate_norm_sq
				FROM candidate_chunks AS c
				JOIN json_each(c.chunk_embedding_json) AS e
				JOIN query_vector AS q
					ON q.idx = CAST(e.key AS INTEGER)
				GROUP BY
					c.workspace_path,
					c.storage_folder,
					c.session_file,
					c.jsonl_absolute_path,
					c.md_absolute_path,
					c.jsonl_last_modified_ms,
					c.chunk_index,
					c.chunk_text,
					c.chunk_embedding_json
			),
			ranked AS (
				SELECT
					workspacePath,
					storageFolder,
					sessionFile,
					jsonlAbsolutePath,
					mdAbsolutePath,
					jsonlLastModifiedMs,
					chunkIndex,
					chunkText,
					chunkEmbeddingJson,
					CASE
						WHEN query_norm_sq = 0 OR candidate_norm_sq = 0 THEN NULL
						ELSE dot_product / (sqrt(query_norm_sq) * sqrt(candidate_norm_sq))
					END AS score
				FROM cosine_components
			)
			SELECT
				workspacePath,
				storageFolder,
				sessionFile,
				jsonlAbsolutePath,
				mdAbsolutePath,
				jsonlLastModifiedMs,
				chunkIndex,
				chunkText,
				chunkEmbeddingJson,
				score
			FROM ranked
			WHERE score IS NOT NULL
				AND score > 0
			ORDER BY score DESC
			LIMIT ?`,
			[queryEmbeddingJson, workspacePath, safeLimit],
		);

		return rows.map((row) => ({
			workspacePath: row.workspacePath,
			storageFolder: row.storageFolder,
			sessionFile: row.sessionFile,
			jsonlAbsolutePath: row.jsonlAbsolutePath,
			mdAbsolutePath: row.mdAbsolutePath,
			jsonlLastModifiedMs: Number(row.jsonlLastModifiedMs),
			chunkIndex: Number(row.chunkIndex),
			chunkText: row.chunkText,
			chunkEmbedding: parseEmbeddingVector(row.chunkEmbeddingJson),
			score: row.score,
		}));
	}

	public async close(): Promise<void> {
		closeDatabase(this.db);
	}
}
