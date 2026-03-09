import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import sqlite3 = require('sqlite3');

export interface SessionRecord {
	workspacePath: string;
	storageFolder: string;
	sessionFile: string;
	customTitle: string;
}

function openDatabase(dbFilePath: string): Promise<sqlite3.Database> {
	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(dbFilePath, (error) => {
			if (error) {
				reject(error);
				return;
			}

			resolve(db);
		});
	});
}

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
	return new Promise((resolve, reject) => {
		db.run(sql, params, (error) => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

function all<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (error, rows) => {
			if (error) {
				reject(error);
				return;
			}

			resolve(rows as T[]);
		});
	});
}

function closeDatabase(db: sqlite3.Database): Promise<void> {
	return new Promise((resolve, reject) => {
		db.close((error) => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

export class SessionDatabase {
	private constructor(private readonly db: sqlite3.Database) {}

	public static async create(dbFilePath: string): Promise<SessionDatabase> {
		await fs.mkdir(path.dirname(dbFilePath), { recursive: true });
		const db = await openDatabase(dbFilePath);
		const instance = new SessionDatabase(db);
		await instance.initialize();
		return instance;
	}

	private async initialize(): Promise<void> {
		await run(this.db, `
			CREATE TABLE IF NOT EXISTS workspace_sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				workspace_path TEXT NOT NULL,
				storage_folder TEXT NOT NULL,
				session_file TEXT NOT NULL,
				custom_title TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(workspace_path, storage_folder, session_file)
			)
		`);

		await run(this.db, `
			CREATE INDEX IF NOT EXISTS idx_workspace_sessions_workspace
			ON workspace_sessions(workspace_path)
		`);
	}

	public async getSessionsByWorkspace(workspacePath: string): Promise<SessionRecord[]> {
		const rows = await all<SessionRecord>(
			this.db,
			`SELECT workspace_path AS workspacePath,
					storage_folder AS storageFolder,
					session_file AS sessionFile,
					custom_title AS customTitle
			 FROM workspace_sessions
			 WHERE workspace_path = ?`,
			[workspacePath],
		);

		return rows;
	}

	public async upsertSessions(sessions: SessionRecord[]): Promise<void> {
		if (sessions.length === 0) {
			return;
		}

		await run(this.db, 'BEGIN TRANSACTION');

		try {
			for (const session of sessions) {
				await run(
					this.db,
					`INSERT INTO workspace_sessions (
						workspace_path,
						storage_folder,
						session_file,
						custom_title
					)
					VALUES (?, ?, ?, ?)
					ON CONFLICT(workspace_path, storage_folder, session_file)
					DO UPDATE SET
						custom_title = excluded.custom_title,
						updated_at = CURRENT_TIMESTAMP`,
					[session.workspacePath, session.storageFolder, session.sessionFile, session.customTitle],
				);
			}

			await run(this.db, 'COMMIT');
		} catch (error) {
			await run(this.db, 'ROLLBACK');
			throw error;
		}
	}

	public async close(): Promise<void> {
		await closeDatabase(this.db);
	}
}
