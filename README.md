# Recuperar Historico Copilot

Extensión de VS Code que busca sesiones previas de Copilot Chat en `workspaceStorage`, extrae `customTitle` desde archivos `.jsonl` y persiste los resultados en una base de datos SQLite para cada workspace.

## Funcionalidad

- Localiza carpetas de `workspaceStorage` asociadas al workspace abierto.
- Escanea `chatSessions/*.jsonl` y detecta sesiones con `customTitle`.
- Guarda en SQLite (usando `sqlite3`) los `customTitle` detectados por workspace.
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

La combinación `workspace_path + storage_folder + session_file` es única para evitar duplicados por sesión.

## Dependencias

- `sqlite3`

## Uso

1. Abre un workspace en VS Code.
2. Invoca el participante de chat `@historico`.
3. Revisa la consola del Extension Host para ver qué sesiones ya estaban guardadas y cuáles se insertaron en SQLite.
