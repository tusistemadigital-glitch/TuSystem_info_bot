# TuSystem_info_bot

Este repositorio agrupa varias instancias de bot Forja, cada una en su **propia
carpeta** (propio `wrangler.toml`, propia base de datos, propio despliegue) para
que los datos de un bot nunca se mezclen con los de otro:

- **`crm/`** — el bot de agencia de TuSystem (giro `crm`, automatizaciones para pymes).
- **`inmobiliaria/`** — bot de demostración para el giro **inmobiliaria** (`BOT_NICHE =
  "inmobiliaria"`), con negocio, catálogo de propiedades y base de conocimiento de
  ejemplo listos para adaptar a un cliente real. Ver `inmobiliaria/README.md`.

Cada carpeta se instala, configura y despliega de forma independiente (`cd <carpeta>`,
`pnpm install`, `/configurar-mi-chatbot` o `pnpm dev` / `pnpm deploy`).
