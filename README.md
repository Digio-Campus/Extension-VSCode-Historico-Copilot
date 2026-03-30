# Recuperar Historico Copilot

Extensión de VS Code que busca sesiones previas de Copilot Chat en `workspaceStorage`, extrae `customTitle` desde archivos `.jsonl` y persiste los resultados en una base de datos SQLite para cada workspace.

## Funcionalidad

- Localiza carpetas de `workspaceStorage` asociadas al workspace abierto.
- Escanea `chatSessions/*.jsonl` y detecta sesiones con `customTitle`.
- Genera un embedding por cada `customTitle` usando la API REST de GitHub Models.
- Guarda en SQLite (usando `better-sqlite3`) el `customTitle` y su embedding por workspace.
- Genera embedding del prompt y hace busqueda vectorial en SQLite.
- Aplica reranking con cross-encoder de Cohere sobre los resultados vectoriales y calcula score final ponderado.
- Muestra en consola dos grupos al usar la extensión:
- sesiones ya almacenadas en la base de datos
- sesiones nuevas o actualizadas que se van a almacenar

## Base de datos

- Archivo: `historico-sesiones.db`
- Ubicación: `context.globalStorageUri.fsPath` de la extensión
- Tabla: `workspace_sessions`

Columnas principales:

- `workspace_path`
- `storage_folder`
- `session_file`
- `custom_title`
- `custom_title_embedding_json`

La combinación `workspace_path + storage_folder + session_file` es única para evitar duplicados por sesión.

## Dependencias

- `better-sqlite3`

## Configuracion de token GitHub Models

- Variable en codigo: `GITHUB_MODELS_TOKEN` en `src/extension.ts`
- Recomendado: definir `GITHUB_MODELS_TOKEN` como variable de entorno para no hardcodear secretos.
- Si usas placeholder (`PUT_YOUR_GITHUB_TOKEN_HERE`), la extension mostrara error al intentar generar embeddings.

## Configuracion de token Cohere

- Variable en codigo: `COHERE_API_KEY` en `src/extension.ts`
- Recomendado: definir `COHERE_API_KEY` como variable de entorno.
- Si no esta configurado, la extension mantiene ranking vectorial sin reranking.

## Uso

1. Abre un workspace en VS Code.
2. Opcional: ejecuta el comando `Historico: Seleccionar modelo de IA del participante` desde la paleta de comandos para elegir el modelo de GitHub Copilot que usara `@historico`.
3. Si no eliges uno, el participante usara por defecto un modelo de la familia `gpt-4.1` (si esta disponible).
4. Invoca el participante de chat `@historico`.
5. Revisa la consola del Extension Host para ver qué sesiones ya estaban guardadas y cuáles se insertaron en SQLite.
