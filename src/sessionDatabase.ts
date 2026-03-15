import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import BetterSqlite3 = require('better-sqlite3');

type SqliteDatabase = ReturnType<typeof BetterSqlite3>;

export interface SessionRecord {
	workspacePath: string;
	storageFolder: string;
	sessionFile: string;
	customTitle: string;
}

function openDatabase(dbFilePath: string): SqliteDatabase {
	const db = new BetterSqlite3(dbFilePath);
	db.pragma('journal_mode = WAL');
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
		const rows = all<SessionRecord>(
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

		const upsertSession = this.db.prepare(
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
		);

		const upsertTransaction = this.db.transaction((items: SessionRecord[]) => {
			for (const session of items) {
				upsertSession.run(
					session.workspacePath,
					session.storageFolder,
					session.sessionFile,
					session.customTitle,
				);
			}
		});

		upsertTransaction(sessions);
	}

	public async close(): Promise<void> {
		closeDatabase(this.db);
	}
}
