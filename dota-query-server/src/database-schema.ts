import type { Pool } from "pg";

interface SchemaColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: "NO" | "YES";
  ordinal_position: number;
  table_name: string;
  table_type: "BASE TABLE" | "VIEW";
  relation_description: string | null;
  udt_name: string;
}

const SCHEMA_COLUMNS_SQL = `
SELECT
  columns.table_name,
  columns.column_name,
  columns.data_type,
  columns.udt_name,
  columns.is_nullable,
  columns.ordinal_position,
  tables.table_type,
  obj_description(
    format('%I.%I', columns.table_schema, columns.table_name)::regclass,
    'pg_class'
  ) AS relation_description
FROM information_schema.columns AS columns
JOIN information_schema.tables AS tables
  ON tables.table_schema = columns.table_schema
  AND tables.table_name = columns.table_name
WHERE columns.table_schema = $1
  AND tables.table_type IN ('BASE TABLE', 'VIEW')
  AND has_table_privilege(
    format('%I.%I', columns.table_schema, columns.table_name),
    'SELECT'
  )
ORDER BY columns.table_name, columns.ordinal_position
`;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function formatDataType(column: SchemaColumnRow): string {
  return column.data_type === "USER-DEFINED" ? column.udt_name : column.data_type;
}

export async function loadDatabaseSchemaDescription(
  database: Pool,
  schemaName: string,
): Promise<string> {
  const result = await database.query<SchemaColumnRow>(SCHEMA_COLUMNS_SQL, [
    schemaName,
  ]);

  if (result.rows.length === 0) {
    throw new Error(
      `No readable tables or views were found in PostgreSQL schema ${quoteIdentifier(schemaName)}.`,
    );
  }

  const tables = new Map<string, SchemaColumnRow[]>();

  for (const column of result.rows) {
    const existingColumns = tables.get(column.table_name) ?? [];
    existingColumns.push(column);
    tables.set(column.table_name, existingColumns);
  }

  return [...tables.entries()]
    .map(([tableName, columns]) => {
      const columnLines = columns.map(
        (column) =>
          `  - ${quoteIdentifier(column.column_name)}: ${formatDataType(column)}${column.is_nullable === "NO" ? " NOT NULL" : ""}`,
      );

      return [
        `${columns[0].table_type === "VIEW" ? "VIEW" : "TABLE"} ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`,
        ...(columns[0].relation_description ? [`  Description: ${columns[0].relation_description}`] : []),
        ...columnLines,
      ].join("\n");
    })
    .join("\n\n");
}
