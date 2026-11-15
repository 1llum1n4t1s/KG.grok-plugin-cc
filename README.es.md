[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-BR.md)

# Plugin de Grok para Claude Code y Codex

Ejecute Grok Build desde Claude Code o Codex para revisiones de código, auditorías de repositorios, búsquedas en X y tareas delegadas. Este proyecto es un fork de [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc); consulte [NOTICE](NOTICE).

## Requisitos e instalación

Instale [Grok Build](https://x.ai/cli), inicie sesión o configure su clave de API, e instale Git 2.45 o posterior (o una compilación de Git con `--no-lazy-fetch` retroportado). En Windows, macOS y Linux, instale Bun 1.4.4 o posterior, o Node.js 22 o posterior; se prefiere Bun cuando ambos están disponibles. El uso de Grok se cobra a la cuenta o a la clave de API utilizada. Grok debe admitir `grok agent stdio`; si es necesario, actualícelo con `grok update`.

En Windows, el plugin incluye helpers nativos para los entornos de ejecución ia32, x64 y arm64. No es necesario instalar Rust ni MSVC.

En Claude Code:

```text
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
/plugin install grok@kagayoi-grok
```

Para Codex, ejecute:

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

Inicie una nueva tarea de Codex para cargar sus skills. Si utiliza ambos hosts, instálelo por separado en cada uno.

### Actualizaciones

Claude Code desactiva de forma predeterminada la actualización automática para los marketplaces de terceros, como `kagayoi-grok`. Para activarla, ejecute `/plugin` en una sesión de Claude Code, abra la pestaña **Marketplaces**, seleccione `kagayoi-grok` y elija **Enable auto-update**. A partir de entonces, Claude Code actualiza el marketplace después de iniciar una sesión y actualiza el plugin instalado; ejecute `/reload-plugins` o inicie una nueva sesión para cargar la nueva versión. Para actualizar de inmediato, ejecute `claude plugin update grok@kagayoi-grok` en su shell.

Para Codex, ejecute `codex plugin marketplace upgrade kagayoi-grok` para actualizar el marketplace y, después, inicie una nueva tarea de Codex.

## Comandos

Claude Code expone `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, `/grok:rescue`, `/grok:x` y `/grok:setup`. En Codex, seleccione el skill `grok:source-command-<name>` correspondiente. La revisión y la auditoría son de solo lectura; rescue puede solicitar ediciones, mientras que la búsqueda en X sigue siendo de solo lectura. Setup comprueba la autenticación de Grok.

En Windows, use `/grok:review --scope working-tree` para revisar los cambios locales. Los alcances `auto` y `working-tree` requieren una instantánea segura y completa en Windows, y fallan si no se puede recopilar. En macOS/Linux, use explícitamente `/grok:review --scope branch` o `--base <ref>` para revisar los cambios confirmados; los cambios sin confirmar se excluyen del diff de comparación, aunque los archivos circundantes aún pueden leerse desde el árbol de trabajo. Use `/grok:audit authentication` para centrar en cualquier plataforma una auditoría de todo el repositorio, o `/grok:rescue <task>` para delegar una tarea. Review, adversarial review y audit también aceptan `--language <BCP 47 tag>`. Ejecute `/grok:setup` cuando falle la instalación o la autenticación; siga el error que informe y las indicaciones de inicio de sesión de Grok.

Cada invocación ejecuta una nueva sesión de Grok en primer plano y devuelve su resultado directamente. Use la propia interfaz de Grok para continuar una conversación. El companion ya no admite las revisiones automáticas ni los antiguos comandos status, result, cancel, state-lock y task-resume.

El companion inicia la CLI de Grok instalada localmente. Comprueba las rutas en las solicitudes de archivos de ACP y aplica una lista de permisos de solo lectura; las tareas de escritura solicitadas explícitamente pueden modificar el espacio de trabajo. Grok Build gestiona sus operaciones integradas de sistema de archivos y shell, el acceso externo y la autenticación. El companion no media todas las operaciones de E/S ni ofrece un sandbox del sistema operativo, y no garantiza un aislamiento de acceso completo, incluso a través de enlaces simbólicos. Revise la salida y los cambios de Grok antes de confiar en ellos.

## Idioma de visualización

Los mensajes propios del companion (resultados de setup, encabezados de revisión, diagnósticos y ayuda) se muestran en el idioma de su entorno. Comprueba `GROK_PLUGIN_LANGUAGE`, luego `LC_ALL`, `LC_MESSAGES` y `LANG`, después el idioma de visualización del sistema, y recurre al inglés. Los idiomas admitidos son `ja`, `en`, `zh-CN`, `zh-TW`, `ko`, `es`, `fr`, `de` y `pt-BR`. Esto es independiente de `--language`, que establece el idioma del texto de revisión de Grok. La salida propia de Grok y los detalles de error del sistema operativo o de Grok no se traducen.

## Solución de problemas

Si una invocación informa de HTTP 402 con `usage balance exhausted`, el saldo de uso de Grok Build se ha agotado. Vuelva a intentarlo cuando ese saldo se recupere. Un tiempo de espera agotado, una denegación de permisos, una revisión incompleta o una detención del agente sin confirmar se consideran una invocación fallida; no trate una salida parcial como una revisión o tarea completada.

Durante las revisiones de solo lectura, se deniegan los wrappers de Python, Node.js, Bun y shell, incluso para scripts destinados únicamente a leer archivos. Grok Build puede terminar el turno con `cancelled` tras el rechazo de un permiso. Use las herramientas de archivos integradas para inspeccionar JSON y otras evidencias; la evidencia no disponible permanece sin verificar. El prompt de revisión proporciona estas restricciones antes de que comience la inspección.

Para compilaciones desde el código fuente, comandos de desarrollo y validación, consulte [Desarrollo](CONTRIBUTING.md#english). La estructura y los límites del runtime se describen en [DESIGN.md](DESIGN.md).
