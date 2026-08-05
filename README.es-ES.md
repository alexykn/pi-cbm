

# pi-cbm

Extensión para Pi que expone [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) como herramientas nativas de Pi. `codebase-memory-mcp` proporciona un gráfico de código local rápido. `pi-cbm` agrega indexación automática y lo adapta para agentes de Pi de una manera deliberadamente optimizada para flujos de trabajo de agentes y ahorro de tokens.

Este paquete no implementa un cliente MCP. Utiliza `codebase-memory-mcp cli --json <tool> <args>` y registra las herramientas principales directamente con Pi. Cuando comienza una sesión de Pi, indexa automáticamente la raíz git actual, o un directorio de trabajo no git seguro cuando está habilitado, en modo completo en segundo plano, y luego lo actualiza periódicamente para que las herramientas de gráficos se mantengan al día.

## ¿Qué lo hace diferente

- **Salida que ahorra tokens por defecto.** Varias herramientas del proyecto original devuelven metadatos ricos del gráfico, huellas digitales, puntuaciones y campos de análisis sin procesar. `pi-cbm` elimina los metadatos menos útiles por defecto y devuelve resultados compactos priorizando la ubicación. Utiliza `include_metadata: true` cuando necesites la carga completa del proyecto original.
- **Controles de compresión de código fuente.** Las herramientas que pueden devolver código admiten `full_output` y `max_symbol_lines`. Los símbolos de tamaño normal se devuelven directamente; los bloques de código de gran tamaño se compactan y el JSON completo sin compactar se guarda en un archivo temporal.
- **Asistentes centrados en símbolos.** `get_code_snippet` del proyecto original funciona mejor cuando ya conoces el `qualified_name` exacto. `pi-cbm` agrega `resolve_symbol` y `read_symbol` para que el agente pueda comenzar desde un nombre de símbolo normal, desambiguar con filtros de archivo/clase/ruta y solo leer el código fuente cuando la coincidencia sea inequívoca.
- **Lectura de símbolos segura por defecto.** `read_symbol` falla de forma segura ante ambigüedades: devuelve identidades candidatas en lugar de adivinar y leer el código fuente incorrecto. Cuando coincide exactamente un símbolo, llama a `get_code_snippet` del proyecto original y puede incluir opcionalmente llamados/lamados directos compactos.
- **Flujos de trabajo de lectura masiva de código fuente.** `get_code_snippets`, `read_symbols` y `search_and_read_symbols` permiten a los agentes inspeccionar varios símbolos relevantes en una sola llamada a la herramienta en lugar de iterar a través de muchas llamadas de símbolo único. Estas herramientas por lotes mantienen los mismos valores predeterminados de metadatos compactos, mientras preservan ubicaciones esenciales, resultados de ambigüedad/errores por elemento y controles de compresión de código fuente.
- **El proyecto actual permanece indexado.** Al iniciar una sesión de Pi, la extensión indexa la raíz git actual, o un directorio de trabajo no git seguro cuando está habilitado, en modo completo y lo actualiza periódicamente en segundo plano. Los directorios raíz, de inicio, del sistema y los directorios integrados comunes del SO nunca se indexan automáticamente.
- **Inferencia de proyecto para flujos de trabajo en el directorio actual.** La mayoría de las herramientas aceptan `project` opcional, pero para el trabajo normal en el repositorio actual, la extensión infiere el proyecto indexado desde el directorio de trabajo actual de Pi.
- **Solo herramientas de consulta.** El agente obtiene herramientas de exploración de código, no controles administrativos. `index_repository` y `list_projects` se usan internamente para la indexación en segundo plano y la inferencia de proyectos; las herramientas MCP destructivas/administrativas como la eliminación de proyectos no se registran como herramientas de Pi.

## Seguridad

Las extensiones de Pi se ejecutan con los permisos de tu usuario local. Esta extensión también ejecuta en una terminal el binario `codebase-memory-mcp` instalado en tu máquina, por lo que instala tanto este paquete como `codebase-memory-mcp` solo desde fuentes que confíes.

## Requisitos: instala codebase-memory-mcp

Instala [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) primero. Estos son los métodos de instalación recomendados por el proyecto original.

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
```

Con la interfaz de usuario opcional de visualización de gráficos:

```sh
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash -s -- --ui
```

### Windows PowerShell

```powershell
# 1. Download the installer
Invoke-WebRequest -Uri https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile install.ps1

# 2. Optional but recommended: inspect the script
notepad install.ps1

# 3. Run it
.\install.ps1
```

Opciones útiles del instalador del proyecto original:

- `--ui` — instala la variante de visualización de gráficos.
- `--skip-config` — instala solo el binario, sin configurar otros agentes.
- `--dir=<path>` — instala en una ubicación personalizada.

### Arch Linux AUR

```sh
yay -S codebase-memory-mcp-bin
```

o:

```sh
paru -S codebase-memory-mcp-bin
```

### Archivo de lanzamiento manual

Descarga el archivo para tu plataforma desde el [último lanzamiento de codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp/releases/latest):

- `codebase-memory-mcp-<platform>-<arch>.tar.gz` para macOS/Linux.
- `codebase-memory-mcp-windows-amd64.zip` para Windows.
- Las variantes `codebase-memory-mcp-ui-...` incluyen la interfaz de usuario de visualización de gráficos.

Luego extrae y ejecuta el instalador incluido:

```sh
tar xzf codebase-memory-mcp-*.tar.gz
./install.sh
```

PowerShell de Windows:

```powershell
Expand-Archive codebase-memory-mcp-windows-amd64.zip -DestinationPath .
.\install.ps1
```

Si el binario no está en `PATH`, configura:

```sh
export CODEBASE_MEMORY_MCP_BIN="$HOME/.local/bin/codebase-memory-mcp"
```

## Instalación

```sh
pi install npm:pi-cbm
```

O prueba para una sola ejecución:

```sh
pi -e npm:pi-cbm
```

## Herramientas

Registra:

- `get_graph_schema`
- `get_architecture`
- `search_graph`
- `resolve_symbol`
- `read_symbol`
- `read_symbols`
- `search_code`
- `get_code_snippet`
- `get_code_snippets`
- `search_and_read_symbols`
- `trace_path`
- `query_graph`
- `detect_changes`

La mayoría de las herramientas aceptan `project` opcional. Cuando se omite, la extensión lo infiere desde las raíces de proyectos indexados que coinciden con el directorio de trabajo actual de Pi. Los agentes deben omitir `project` para trabajos en el directorio actual/proyecto actual y proporcionarlo solo cuando consulten intencionalmente un proyecto indexado externo.

## Comandos

### `/cbm`

Abre el menú de configuración de pi-cbm:

- `/cbm menu` — muestra el menú de configuración interactivo.
- `/cbm status` — muestra la configuración de autoindexación.
- `/cbm enable-non-git` — indexa automáticamente directorios de trabajo seguros sin git.
- `/cbm disable-non-git` — solo indexa automáticamente repositorios git.

La autoindexación sin git está habilitada por defecto para preservar los flujos de trabajo normales del directorio actual. La protección contra rutas inseguras siempre está habilitada: se omiten las raíces del sistema de archivos, los directorios de inicio, los directorios del sistema y los directorios integrados comunes de macOS/Linux, mostrando un mensaje de estado que explica por qué.

Notas:

- Usa `search_graph` primero para descubrir símbolos/flujos de trabajo/rutas/clases/funciones y preguntas como “¿dónde está implementado X?”. Usa un límite pequeño para búsquedas dirigidas.
- Usa `search_and_read_symbols` cuando necesites descubrir ubicaciones de implementación e inspeccionar el código fuente de las principales coincidencias. Preferirlo sobre `search_graph` seguido de muchas lecturas individuales de fragmentos. Mantén `read_limit` pequeño, usualmente 3–8.
- Usa `resolve_symbol` cuando conozcas un nombre de símbolo pero necesites el `qualified_name` exacto o debas desambiguar candidatos.
- Usa `read_symbol` cuando conozcas un nombre de símbolo junto con suficientes desambiguadores, como `file_path`, `parent_class`, `label`, `route_path` o `route_method`, y quieras el código fuente solo si la coincidencia es inequívoca.
- Usa `read_symbols` cuando conozcas varios nombres de símbolos concretos y necesites su código fuente en una sola llamada. Cada elemento falla de forma segura ante ambigüedades como `read_symbol`; reintenta solo los elementos ambiguos con desambiguadores más fuertes.
- `read_symbol` falla de forma segura ante ambigüedades; si devuelve candidatos, reintenta con más desambiguadores o usa `get_code_snippet` con un `qualified_name` exacto.
- `read_symbol` admite `neighbors: "callers" | "callees" | "both"` más `neighbor_limit` para contexto de llamadas circundante directo, compacto y sin código fuente. Usa `trace_path` para rastreo de flujos de trabajo o impacto de múltiples saltos.
- Usa `get_code_snippet` cuando ya tengas un `qualified_name` exacto; prefiere `read_symbol` cuando tengas un nombre de símbolo concreto junto con desambiguadores pero no el `qualified_name` exacto.
- Usa `get_code_snippets` cuando ya tengas varios valores exactos de `qualified_name` procedentes de búsquedas, rastreo o resultados de consultas. Preferirlo sobre llamadas repetidas a `get_code_snippet`.
- Si la consulta es un nombre de símbolo, prefiere `resolve_symbol`/`read_symbol`; si es una cadena exacta no simbólica o necesitas todas las ocurrencias textuales, usa `search_code`.
- Usa `search_code` para búsquedas exactas de texto literal/regex como variables de entorno, claves de configuración, cadenas de ruta, mensajes de error, constantes, texto de plantillas, comentarios y docstrings.
- Usa `trace_path` después de identificar un símbolo de anclaje cuando necesites contexto de llamados, llamados/referidos, flujo de trabajo, dependencias, flujo de datos o radio de impacto. Mantén la profundidad superficial por defecto.
- Usa `get_code_snippet` solo después de que `search_graph`/`search_code` identifique el símbolo exacto. Mantén la recuperación de fragmentos dirigida en lugar de leer masivamente muchos símbolos.
- Usa `get_architecture` para una orientación general en repositorios desconocidos, no para búsqueda dirigida de implementaciones. Los aspectos solicitados pueden estar ausentes si el índice no tiene datos para ellos.
- Usa `get_graph_schema` antes de consultas `query_graph` no triviales, y mantén estrechas las columnas devueltas por `query_graph`.
- Usa `detect_changes` para revisión de diffs o análisis de radio de impacto, no para búsqueda de código ordinaria.
- Lee directamente las rutas obvias de README/paquete/despliegue/manifestos de configuración en lugar de forzar a las herramientas de gráficos a realizar trabajo de inspección de archivos.
- `trace_path` resuelve automáticamente nombres cortos de funciones/métodos cuando hay una única coincidencia inequívoca; de lo contrario, devuelve `qualified_name` candidatos. También admite filtros explícitos `exclude_paths` del lado del plugin.
- Las herramientas de exploración como `search_graph`, `get_code_snippet`, `trace_path`, `get_architecture`, `search_code` y `detect_changes` tienen por defecto una salida compacta priorizando la ubicación. Los metadatos del gráfico del proyecto original menos útiles, como huellas digitales, campos de tokens y métricas sin procesar, se ocultan a menos que se configure `include_metadata: true`.
- Las herramientas por lotes/de código fuente como `get_code_snippets`, `read_symbols` y `search_and_read_symbols` usan los mismos valores predeterminados de metadatos compactos: preservan la identidad esencial como `file_path`, `start_line`, `end_line`, `qualified_name`, firmas y campos de ruta, mientras eliminan metadatos de gráficos sin procesar menos útiles a menos que se configure `include_metadata: true`.
- La salida compacta oculta metadatos de análisis, no la identidad de ubicación crítica para ediciones. Las salidas similares a símbolos preservan `file_path`, `start_line` y `end_line` cuando están disponibles, y el plugin enriquece las ubicaciones faltantes para salidas de resolución, rastreo y arquitectura donde sea posible.
- Las herramientas intensivas en código/código fuente admiten `full_output` y `max_symbol_lines`. Por defecto, los símbolos de tamaño normal se devuelven completos y solo se compactan bloques de gran tamaño de función/método/clase.
- `search_code` tiene por defecto una salida compacta con poco contexto para evitar saturar el contexto del agente, y los contextos por símbolo de gran tamaño se compactan a menos que `full_output=true` o `max_symbol_lines` se aumente. Si un resultado se compacta/trunca, los agentes deben reintentar la misma herramienta de codebase-memory con un `max_symbol_lines` mayor o `full_output=true` antes de recurrir a lecturas de archivos/grep.
- `query_graph` normaliza columnas comunes de métricas numéricas en las filas devueltas para un consumo más fácil por parte del agente, aunque sigue dependiendo del proyecto original para la ejecución/orden de la consulta.

## Flujo de trabajo típico

Pide a Pi:

```text
Give me the architecture overview.
```

La extensión indexa y actualiza periódicamente el repositorio actual en segundo plano, por lo que el agente debería dirigirse directamente a `get_architecture`, `search_graph`, `get_code_snippet`, `trace_path`, `search_code` o `query_graph` para la exploración estructural del código. Las operaciones administrativas de índice permanecen disponibles a través de la CLI `codebase-memory-mcp` cuando sea necesario.
