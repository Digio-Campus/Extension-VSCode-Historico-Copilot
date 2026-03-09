import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { SessionDatabase, type SessionRecord } from './sessionDatabase';

const CHAT_PARTICIPANT_ID = 'recuperar-historico-copilot.recuperador';
const WORKSPACE_STORAGE_PATH = 'C:\\Users\\Usuario\\AppData\\Roaming\\Code\\User\\workspaceStorage';
const DATABASE_FILE_NAME = 'historico-sesiones.db';

interface DetectedSessionTitle {
	storageFolder: string;
	sessionFile: string;
	customTitle: string;
}

function normalizePathForSearch(value: string): string {
	return value.replaceAll('\\', '/').toLowerCase();
}

function workspacePathToStorageUri(workspacePath: string): string {
	// workspace.json stores folders as encoded file URIs (e.g. file:///c%3A/Users/...).
	return vscode.Uri.file(workspacePath).toString().toLowerCase();
}

function jsonContainsExactNormalizedPath(value: unknown, targetPath: string): boolean {
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

function findFirstStringProperty(value: unknown, propertyName: string): string | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findFirstStringProperty(item, propertyName);
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const directValue = record[propertyName];
	if (typeof directValue === 'string' && directValue.trim().length > 0) {
		return directValue;
	}

	for (const nestedValue of Object.values(record)) {
		const found = findFirstStringProperty(nestedValue, propertyName);
		if (found) {
			return found;
		}
	}

	return undefined;
}

function extractCustomTitleFromJsonl(content: string): string | undefined {
	const lines = content.split(/\r?\n/);

	for (const line of lines) {
		const trimmedLine = line.trim();
		if (!trimmedLine) {
			continue;
		}

		try {
			const parsedLine = JSON.parse(trimmedLine) as unknown;
			const customTitle = findFirstStringProperty(parsedLine, 'customTitle');
			if (customTitle) {
				return customTitle;
			}
		} catch {
			// Ignore malformed lines and continue scanning the rest of the file.
		}
	}

	return undefined;
}

function buildSessionKey(storageFolder: string, sessionFile: string): string {
	return `${normalizePathForSearch(storageFolder)}::${sessionFile.toLowerCase()}`;
}

function logSessionsInConsole(title: string, sessions: SessionRecord[]): void {
	console.log(`[historico] ${title} (${sessions.length})`);

	if (sessions.length === 0) {
		console.log('[historico] - ninguna');
		return;
	}

	for (const session of sessions) {
		console.log(`[historico] - ${session.customTitle} | ${session.storageFolder}\\chatSessions\\${session.sessionFile}`);
	}
}

async function collectChatSessionCustomTitles(candidateFolder: string): Promise<DetectedSessionTitle[]> {
	const chatSessionsFolder = path.join(candidateFolder, 'chatSessions');

	let chatSessionsEntries: Dirent[];
	try {
		chatSessionsEntries = await fs.readdir(chatSessionsFolder, { withFileTypes: true });
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
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

	const sessionsWithTitle = await Promise.all(jsonlFiles.map(async (jsonlFile) => {
		const jsonlPath = path.join(chatSessionsFolder, jsonlFile.name);

		try {
			const jsonlContent = await fs.readFile(jsonlPath, 'utf8');
			const customTitle = extractCustomTitleFromJsonl(jsonlContent);

			if (customTitle) {
				return {
					storageFolder: candidateFolder,
					sessionFile: jsonlFile.name,
					customTitle,
				} satisfies DetectedSessionTitle;
			} else {
				console.log(`[historico] No se encontro customTitle en: ${jsonlFile.name}`);
			}
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			console.warn(`[historico] No se pudo leer ${jsonlPath}: ${nodeError.message}`);
		}

		return undefined;
	}));

	return sessionsWithTitle.filter((session): session is DetectedSessionTitle => Boolean(session));
}

async function findMatchingWorkspaceStorageFolders(currentWorkspacePath: string): Promise<string[]> {
	const directoryEntries = await fs.readdir(WORKSPACE_STORAGE_PATH, { withFileTypes: true });
	const matches: string[] = [];
	const normalizedWorkspaceUri = workspacePathToStorageUri(currentWorkspacePath);

	await Promise.all(directoryEntries.map(async (entry) => {
		if (!entry.isDirectory()) {
			return;
		}

		const candidateFolder = path.join(WORKSPACE_STORAGE_PATH, entry.name);
		const workspaceJsonPath = path.join(candidateFolder, 'workspace.json');

		try {
			const workspaceJsonContent = await fs.readFile(workspaceJsonPath, 'utf8');
			// console.log(`[historico] Contenido de workspace.json: ${workspaceJsonContent}`);

			let containsCurrentWorkspacePath = false;
			try {
				const parsedWorkspaceJson = JSON.parse(workspaceJsonContent) as unknown;
				containsCurrentWorkspacePath = jsonContainsExactNormalizedPath(parsedWorkspaceJson, normalizedWorkspaceUri);
			} catch {
				// Fallback for unexpected formats: keep text-level matching.
				containsCurrentWorkspacePath = normalizePathForSearch(workspaceJsonContent).includes(normalizedWorkspaceUri);
			}

			if (containsCurrentWorkspacePath) {
				matches.push(candidateFolder);
			}
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code && nodeError.code !== 'ENOENT') {
				console.warn(`[historico] No se pudo leer ${workspaceJsonPath}: ${nodeError.message}`);
			}
		}
	}));

	return matches.sort();
}


export function activate(context: vscode.ExtensionContext): void {

	const helloWorldCommand = vscode.commands.registerCommand('recuperar-historico-copilot.helloWorld', () => {
		vscode.window.showInformationMessage('Participante de chat @historico listo para leer sesiones previas.');
	});

	const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, async (_request, _chatContext, response) => {
		const currentWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		if (!currentWorkspacePath) {
			response.markdown('No hay un workspace abierto para comparar rutas.');
			console.warn('[historico] No se encontro un workspace abierto.');
			return;
		}

		response.progress('Buscando coincidencias en workspaceStorage...');

		let matchingFolders: string[];
		try {
			matchingFolders = await findMatchingWorkspaceStorageFolders(currentWorkspacePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			response.markdown(`Error al buscar en workspaceStorage: ${message}`);
			console.error('[historico] Error escaneando workspaceStorage:', error);
			return;
		}

		console.log(`[historico] Workspace actual: ${currentWorkspacePath} y matchingFolders encontrados: ${matchingFolders.length}`);
		if (matchingFolders.length === 0) {
			console.log('[historico] No se encontraron carpetas con la ruta del workspace actual.');
			response.markdown('No se encontraron carpetas coincidentes en `workspaceStorage`.');
			return;
		}
		else {
			console.log('[historico] Carpetas encontradas:');
			for (const folder of matchingFolders) {
				console.log(folder);
			}

			const detectedTitlesByFolder = await Promise.all(
				matchingFolders.map((folder) => collectChatSessionCustomTitles(folder)),
			);
			const detectedTitles = detectedTitlesByFolder.flat();

			if (detectedTitles.length === 0) {
				console.log('[historico] No se detectaron sesiones con customTitle para almacenar.');
				response.markdown('Se encontraron carpetas coincidentes, pero no sesiones con `customTitle`.');
				return;
			}

			const dbFilePath = path.join(context.globalStorageUri.fsPath, DATABASE_FILE_NAME);
			console.log(`[historico] Se van a procesar ${detectedTitles.length} sesiones con customTitle. Ruta de DB: ${dbFilePath}`);
			let database: SessionDatabase | undefined;

			try {
				database = await SessionDatabase.create(dbFilePath);
				const storedSessions = await database.getSessionsByWorkspace(currentWorkspacePath);
				const storedByKey = new Map<string, SessionRecord>();

				for (const session of storedSessions) {
					storedByKey.set(buildSessionKey(session.storageFolder, session.sessionFile), session);
				}

				const alreadyStoredSessions: SessionRecord[] = [];
				const sessionsToStore: SessionRecord[] = [];

				for (const detectedTitle of detectedTitles) {
					const record: SessionRecord = {
						workspacePath: currentWorkspacePath,
						storageFolder: detectedTitle.storageFolder,
						sessionFile: detectedTitle.sessionFile,
						customTitle: detectedTitle.customTitle,
					};

					const key = buildSessionKey(record.storageFolder, record.sessionFile);
					const existingSession = storedByKey.get(key);

					if (existingSession && existingSession.customTitle === record.customTitle) {
						alreadyStoredSessions.push(record);
					} else {
						sessionsToStore.push(record);
					}
				}

				logSessionsInConsole('Sesiones ya almacenadas en SQLite', alreadyStoredSessions);
				logSessionsInConsole('Sesiones que se van a almacenar en SQLite', sessionsToStore);

				await database.upsertSessions(sessionsToStore);

				response.markdown(
					`Se detectaron ${detectedTitles.length} sesiones con customTitle. ` +
					`${alreadyStoredSessions.length} ya estaban guardadas y ${sessionsToStore.length} se guardaron en SQLite. ` +
					`Revisa la consola del Extension Host para ver el detalle.`,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				response.markdown(`Error trabajando con SQLite: ${message}`);
				console.error('[historico] Error guardando sesiones en SQLite:', error);
			} finally {
				if (database) {
					await database.close();
				}
			}
		}
	});

	context.subscriptions.push(helloWorldCommand);
	context.subscriptions.push(participant);
}

export function deactivate(): void {}