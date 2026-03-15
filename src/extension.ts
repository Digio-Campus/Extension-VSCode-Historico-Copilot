import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { SessionDatabase, type SessionRecord } from './sessionDatabase';

const CHAT_PARTICIPANT_ID = 'recuperar-historico-copilot.recuperador';
const SELECT_MODEL_COMMAND_ID = 'recuperar-historico-copilot.selectChatModel';
const WORKSPACE_STORAGE_PATH = 'C:\\Users\\Usuario\\AppData\\Roaming\\Code\\User\\workspaceStorage';
const DATABASE_FILE_NAME = 'historico-sesiones.db';
const MODEL_GLOBAL_STATE_KEY = 'historico.selectedCopilotModelId';
const DEFAULT_MODEL_FAMILY = 'gpt-4.1';

interface DetectedSessionTitle {
	storageFolder: string;
	sessionFile: string;
	customTitle: string;
}

interface ProcessingOutcome {
	statusMessage: string;
	contextForModel: string;
}

interface CopilotModelQuickPickItem extends vscode.QuickPickItem {
	model: vscode.LanguageModelChat;
}

const ALL_COPILOT_MODELS_SELECTOR: vscode.LanguageModelChatSelector = {
	vendor: 'copilot',
};

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

function buildModelContextFromDetectedTitles(detectedTitles: DetectedSessionTitle[]): string {
	if (detectedTitles.length === 0) {
		return 'No se detectaron customTitle en los jsonl analizados.';
	}

	const maxTitles = 15;
	const titleLines = detectedTitles
		.slice(0, maxTitles)
		.map((title) => `- ${title.customTitle}`)
		.join('\n');
	const overflowCount = Math.max(0, detectedTitles.length - maxTitles);
	const overflowLine = overflowCount > 0 ? `\n- ... y ${overflowCount} titulo(s) mas` : '';

	return `Titulos detectados (${detectedTitles.length}):\n${titleLines}${overflowLine}`;
}

function isDefaultModelFamily(model: vscode.LanguageModelChat): boolean {
	return model.family.toLowerCase() === DEFAULT_MODEL_FAMILY;
}

function pickDefaultCopilotModel(models: vscode.LanguageModelChat[]): vscode.LanguageModelChat | undefined {
	const gpt41Model = models.find((model) => isDefaultModelFamily(model));
	if (gpt41Model) {
		return gpt41Model;
	}

	return models[0];
}

async function getAvailableCopilotModels(): Promise<vscode.LanguageModelChat[]> {
	return vscode.lm.selectChatModels(ALL_COPILOT_MODELS_SELECTOR);
}

async function resolveModelWithDefaultPreference(
	context: vscode.ExtensionContext,
	requestModel: vscode.LanguageModelChat,
): Promise<vscode.LanguageModelChat> {
	try {
		const copilotModels = await getAvailableCopilotModels();
		if (copilotModels.length === 0) {
			return requestModel;
		}

		const selectedModelId = context.globalState.get<string>(MODEL_GLOBAL_STATE_KEY);
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
	} catch (error) {
		console.warn('[historico] No se pudo seleccionar modelo Copilot configurado:', error);
	}

	return requestModel;
}

function formatModelDescription(model: vscode.LanguageModelChat): string {
	const parts = [model.family];
	if (model.version) {
		parts.push(model.version);
	}

	if (isDefaultModelFamily(model)) {
		parts.push('default: GPT-4.1');
	}

	return parts.join(' | ');
}

async function selectParticipantModel(context: vscode.ExtensionContext): Promise<void> {
	let copilotModels: vscode.LanguageModelChat[];

	try {
		copilotModels = await getAvailableCopilotModels();
	} catch (error) {
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

	const selectedModelId = context.globalState.get<string>(MODEL_GLOBAL_STATE_KEY);
	const activeModelId = selectedModelId ?? defaultModel.id;

	const quickPickItems = copilotModels
		.map((model) => ({
			label: model.name,
			description: formatModelDescription(model),
			detail: model.id,
			picked: model.id === activeModelId,
			model,
		} satisfies CopilotModelQuickPickItem))
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

async function answerInvocationPrompt(
	context: vscode.ExtensionContext,
	request: vscode.ChatRequest,
	response: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	processingContext: string,
): Promise<void> {
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
		const llmResponse = await model.sendRequest(
			[vscode.LanguageModelChatMessage.User(llmPrompt)],
			undefined,
			token,
		);

		response.markdown('\n\n---\n\n**Respuesta al prompt**\n\n');
		for await (const chunk of llmResponse.text) {
			response.markdown(chunk);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		response.markdown(`\n\nNo se pudo generar respuesta con el modelo: ${message}`);
		console.error('[historico] Error al responder el prompt con el modelo:', error);
	}
}


export function activate(context: vscode.ExtensionContext): void {

	const helloWorldCommand = vscode.commands.registerCommand('recuperar-historico-copilot.helloWorld', () => {
		vscode.window.showInformationMessage('Participante de chat @historico listo para leer sesiones previas.');
	});

	const selectModelCommand = vscode.commands.registerCommand(SELECT_MODEL_COMMAND_ID, async () => {
		await selectParticipantModel(context);
	});

	const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, async (request, _chatContext, response, token) => {
		const currentWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		let processingOutcome: ProcessingOutcome;

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

		let matchingFolders: string[];
		try {
			matchingFolders = await findMatchingWorkspaceStorageFolders(currentWorkspacePath);
		} catch (error) {
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
			console.log('[historico] No se encontraron carpetas con la ruta del workspace actual.');
			processingOutcome = {
				statusMessage: 'No se encontraron carpetas coincidentes en `workspaceStorage`.',
				contextForModel: `No hubo coincidencias de workspaceStorage para ${currentWorkspacePath}.`,
			};
			response.markdown(processingOutcome.statusMessage);
			await answerInvocationPrompt(context, request, response, token, processingOutcome.contextForModel);
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
				processingOutcome = {
					statusMessage: 'Se encontraron carpetas coincidentes, pero no sesiones con `customTitle`.',
					contextForModel: `Se encontraron ${matchingFolders.length} carpeta(s) coincidente(s), pero sin customTitle.`,
				};
				response.markdown(processingOutcome.statusMessage);
				await answerInvocationPrompt(context, request, response, token, processingOutcome.contextForModel);
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

				logSessionsInConsole('Sesiones ya almacenadas en better-sqlite3', alreadyStoredSessions);
				logSessionsInConsole('Sesiones que se van a almacenar en better-sqlite3', sessionsToStore);

				await database.upsertSessions(sessionsToStore);

				processingOutcome = {
					statusMessage:
						`Se detectaron ${detectedTitles.length} sesiones con customTitle. ` +
						`${alreadyStoredSessions.length} ya estaban guardadas y ${sessionsToStore.length} se guardaron en better-sqlite3. ` +
						'Revisa la consola del Extension Host para ver el detalle.',
					contextForModel: [
						`Workspace: ${currentWorkspacePath}`,
						`Carpetas coincidentes: ${matchingFolders.length}`,
						`Sesiones detectadas con customTitle: ${detectedTitles.length}`,
						`Ya almacenadas: ${alreadyStoredSessions.length}`,
						`Insertadas/actualizadas en better-sqlite3: ${sessionsToStore.length}`,
						buildModelContextFromDetectedTitles(detectedTitles),
					].join('\n'),
				};

				response.markdown(processingOutcome.statusMessage);
				await answerInvocationPrompt(context, request, response, token, processingOutcome.contextForModel);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				processingOutcome = {
					statusMessage: `Error trabajando con better-sqlite3: ${message}`,
					contextForModel: `Fallo al guardar sesiones para ${currentWorkspacePath}: ${message}`,
				};
				response.markdown(processingOutcome.statusMessage);
				console.error('[historico] Error guardando sesiones en better-sqlite3:', error);
				await answerInvocationPrompt(context, request, response, token, processingOutcome.contextForModel);
			} finally {
				if (database) {
					await database.close();
				}
			}
		}
	});

	context.subscriptions.push(helloWorldCommand);
	context.subscriptions.push(selectModelCommand);
	context.subscriptions.push(participant);
}

export function deactivate(): void {}