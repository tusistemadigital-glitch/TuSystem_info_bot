# TuSystem_info_bot

Este repositorio agrupa varias instancias de bot Forja, cada una en su **propia
carpeta** (propio `wrangler.toml`, propia base de datos, propio despliegue) para
que los datos de un bot nunca se mezclen con los de otro:

- **`crm/`** — el bot de agencia de TuSystem (giro `crm`, automatizaciones para pymes).
- **`inmobiliaria/`** — bot de **Inmobiliaria TuSystem** (giro `inmobiliaria`), con un
  prompt "modo experto" propio (consulta propiedades en vivo por Google Sheets/Composio,
  agenda/mueve/cancela visitas con email de confirmación). Ver `inmobiliaria/README.md`
  para lo que falta implementar antes de publicarlo.

Cada carpeta se instala, configura y despliega de forma independiente (`cd <carpeta>`,
`pnpm install`, `/configurar-mi-chatbot` o `pnpm dev` / `pnpm deploy`).
