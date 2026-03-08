import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';

const CHAT_PARTICIPANT_ID = 'recuperar-historico-copilot.recuperador';
const WORKSPACE_STORAGE_PATH = 'C:\\Users\\Usuario\\AppData\\Roaming\\Code\\User\\workspaceStorage';

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

async function logChatSessionCustomTitles(candidateFolder: string): Promise<void> {
	const chatSessionsFolder = path.join(candidateFolder, 'chatSessions');

	let chatSessionsEntries: Dirent[];
	try {
		chatSessionsEntries = await fs.readdir(chatSessionsFolder, { withFileTypes: true });
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === 'ENOENT') {
			console.log(`[historico] La carpeta chatSessions no existe en: ${candidateFolder}`);
			return;
		}

		console.warn(`[historico] No se pudo leer la carpeta chatSessions en ${candidateFolder}: ${nodeError.message}`);
		return;
	}

	const jsonlFiles = chatSessionsEntries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'));
	if (jsonlFiles.length === 0) {
		console.log(`[historico] No hay archivos .jsonl en: ${chatSessionsFolder}`);
		return;
	}

	await Promise.all(jsonlFiles.map(async (jsonlFile) => {
		const jsonlPath = path.join(chatSessionsFolder, jsonlFile.name);

		try {
			const jsonlContent = await fs.readFile(jsonlPath, 'utf8');
			const customTitle = extractCustomTitleFromJsonl(jsonlContent);

			if (customTitle) {
				console.log(`[historico] customTitle (${jsonlFile.name}): ${customTitle}`);
			} else {
				console.log(`[historico] No se encontro customTitle en: ${jsonlFile.name}`);
			}
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			console.warn(`[historico] No se pudo leer ${jsonlPath}: ${nodeError.message}`);
		}
	}));
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
				await logChatSessionCustomTitles(folder);
			}

			response.markdown(`Se encontraron ${matchingFolders.length} carpeta(s). Revisa la consola del Extension Host para ver el detalle.`);
		}
	});

	context.subscriptions.push(helloWorldCommand);
	context.subscriptions.push(participant);
}

export function deactivate(): void {}