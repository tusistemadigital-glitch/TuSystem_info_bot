// One-off generator: reads member/system-prompt-override.txt and writes
// scripts/seed-system-prompt.sql with the SQL string properly escaped.
// Not a package.json script — run manually after editing the .txt source.
import { readFileSync, writeFileSync } from "node:fs";

const text = readFileSync("member/system-prompt-override.txt", "utf8").replace(/\n$/, "");
const escaped = text.replace(/'/g, "''");

const sql = `-- scripts/seed-system-prompt.sql
-- Instala el prompt "modo experto" (system_prompt_override) de Inmobiliaria TuSystem.
-- Fuente legible: member/system-prompt-override.txt (edita ahí y regenera este
-- archivo con: node scripts/_gen-seed-prompt.mjs). Reemplaza TODO el prompt
-- generado por Forja — ver skill/prompt.md, Opción 5 ("Modo experto").
--
-- Local (miniflare):    pnpm run seed:prompt
-- Remoto (bot en vivo): pnpm run seed:prompt:remote
INSERT INTO settings (key, value, updated_at)
VALUES ('system_prompt_override', '${escaped}', strftime('%s','now')*1000)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
`;

writeFileSync("scripts/seed-system-prompt.sql", sql);
console.log(`wrote scripts/seed-system-prompt.sql (${sql.length} bytes)`);
