# Recuperar Historico Copilot

Extension de VS Code para recuperar conversaciones previas de GitHub Copilot Chat, indexarlas en una base local y reutilizar ese contexto cuando invocas al participante `@historico`.

## Funcionamiento general

La extension actua como un participante de chat llamado `@historico`.

Cuando la invocas:

1. Localiza las sesiones JSONL de Copilot asociadas al workspace actual.
2. Convierte esas sesiones a Markdown legible.
3. Divide el contenido en chunks y calcula embeddings para cada chunk.
4. Guarda todo en SQLite (`better-sqlite3`) para busqueda rapida.
5. Si tu prompt tiene texto, busca por similitud vectorial los chunks mas relevantes.
6. Intenta mejorar el ranking con Cohere (cross-encoder). Si falla o no hay API key, usa ranking vectorial puro.
7. Construye contexto con resultados y responde usando un modelo de Copilot seleccionado para `@historico`.

## Proposito

Su objetivo es recuperar conocimiento de chats pasados de Copilot y usarlo como contexto util para responder en el chat actual, sin tener que buscar manualmente en archivos de sesion.

## Flujo paso a paso

### 1) Deteccion del workspace y sus sesiones

- Toma el primer workspace abierto en VS Code.
- Busca coincidencias en `workspaceStorage` para ese workspace.
- Dentro de cada carpeta coincidente, inspecciona `chatSessions` y detecta archivos `.jsonl`.

### 2) Sincronizacion e indexacion incremental

- Crea/abre una base de datos SQLite local: `historico-sesiones.db`.
- Elimina de la base archivos que ya no existen en el workspace.
- Compara cada JSONL detectado con lo almacenado (ruta/metadata/ultima modificacion).
- Solo reindexa los que cambiaron o son nuevos.

### 3) Conversion de JSONL a Markdown

- Lee cada linea JSONL.
- Extrae titulo de sesion (si existe `customTitle`).
- Extrae pares de mensaje de usuario y respuesta de IA.
- Genera un `.md` temporal en el directorio temporal del sistema.

### 4) Chunking y embeddings

- Divide el Markdown en chunks de texto usando `maxTokensPerChunk` y `chunkOverlapTokens`.
- Solicita embeddings por chunk al endpoint configurado.
- Guarda chunks + embeddings en SQLite para busquedas posteriores.

### 5) Recuperacion para el prompt actual

- Si tu prompt no esta vacio, genera su embedding.
- Ejecuta busqueda vectorial (cosine similarity) en los chunks indexados.
- Obtiene los mejores candidatos iniciales.

### 6) Reranking hibrido (opcional)

- Si hay resultados vectoriales, intenta rerank con Cohere.
- Combina score vectorial y score de rerank en un score final ponderado.
- Si no hay API key o falla Cohere, mantiene ranking vectorial.

### 7) Respuesta final

- Construye un contexto de procesamiento (archivos, chunks, resultados, configuracion activa, errores).
- Selecciona el modelo de Copilot para el participante `@historico`.
- Responde en español con ese contexto como base.

## Comandos disponibles

- `recuperar-historico-copilot.helloWorld`
	- Mensaje basico de verificacion del participante.
- `recuperar-historico-copilot.selectChatModel`
	- Permite elegir el modelo de IA que usara `@historico`.

## Opciones de configuracion

Todas las opciones viven bajo el bloque `recuperarHistoricoCopilot`.

### `recuperarHistoricoCopilot.maxTokensPerChunk`

- Tipo: `number`
- Default: `128`
- Minimo: `1`
- Uso: tamano maximo aproximado de tokens por chunk al indexar.

### `recuperarHistoricoCopilot.chunkOverlapTokens`

- Tipo: `number`
- Default: `25`
- Minimo: `0`
- Uso: solape entre chunks consecutivos para no perder contexto entre cortes.

### `recuperarHistoricoCopilot.cohereApiKey`

- Tipo: `string`
- Default: `""`
- Scope: `machine-overridable`
- Uso: API key para reranking con Cohere.
- Fallback: si queda vacia, la extension intenta usar la variable de entorno `COHERE_API_KEY`.

### `recuperarHistoricoCopilot.embeddingsEndpoint`

- Tipo: `string`
- Default: `http://localhost:11434/api/embeddings`
- Scope: `machine-overridable`
- Uso: endpoint HTTP para generar embeddings de chunks y prompts.

### `recuperarHistoricoCopilot.embeddingModel`

- Tipo: `string`
- Default: `nomic-embed-text:latest`
- Uso: nombre del modelo que se envia al endpoint de embeddings.

### `recuperarHistoricoCopilot.embeddingDimensions`

- Tipo: `number`
- Default: `768`
- Minimo: `1`
- Uso: dimensiones esperadas del vector embedding devuelto.
- Nota: si no coincide con la respuesta real del endpoint, la indexacion/busqueda falla para ese elemento.

### `recuperarHistoricoCopilot.cohereRerankModel`

- Tipo: `string`
- Default: `rerank-v3.5`
- Uso: modelo de Cohere usado para el reranking.

## Ejemplo de configuracion (`settings.json`)

```json
{
	"recuperarHistoricoCopilot.maxTokensPerChunk": 128,
	"recuperarHistoricoCopilot.chunkOverlapTokens": 25,
	"recuperarHistoricoCopilot.cohereApiKey": "",
	"recuperarHistoricoCopilot.embeddingsEndpoint": "http://localhost:11434/api/embeddings",
	"recuperarHistoricoCopilot.embeddingModel": "nomic-embed-text:latest",
	"recuperarHistoricoCopilot.embeddingDimensions": 768,
	"recuperarHistoricoCopilot.cohereRerankModel": "rerank-v3.5"
}
```

## Requisitos operativos

- VS Code `^1.109.0`.
- Endpoint de embeddings accesible por HTTP (por defecto en localhost).
- Para reranking, API key de Cohere via setting o variable de entorno.

## Limitaciones actuales

- La deteccion de `workspaceStorage` esta orientada a una ruta fija de Windows.
- La extension toma el primer workspace folder abierto para resolver contexto.
- Si el endpoint de embeddings no responde o devuelve formato incompatible, no se pueden indexar/buscar chunks de ese ciclo.

