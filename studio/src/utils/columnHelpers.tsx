import { type ColumnDef } from '@tanstack/react-table'
import { Link } from 'react-router-dom'
import ReactJson from 'react-json-view'

/**
 * Creates the select checkbox column for data tables
 */
export function createSelectColumn<T>(): ColumnDef<T> {
  return {
    id: 'select',
    header: ({ table }) => (
      <input
        type="checkbox"
        checked={table.getIsAllRowsSelected()}
        onChange={table.getToggleAllRowsSelectedHandler()}
        className="rounded border-border"
      />
    ),
    cell: ({ row }) => (
      <input
        type="checkbox"
        checked={row.getIsSelected()}
        onChange={row.getToggleSelectedHandler()}
        className="rounded border-border"
      />
    ),
  }
}

/**
 * Renders a cell value, displaying objects as ReactJson and primitives as text
 */
export function renderCellValue(
    value: any,
    extractValue = false,
    autoExpandRow = false
): JSX.Element {
    // If extractValue is true and value has a .value property, extract it
    let actualValue =
        extractValue && value?.value !== undefined ? value.value : value;

    actualValue = actualValue ?? "-";

    if (typeof actualValue === "object" && actualValue !== null) {
        return (
            <div className="max-w-xs">
                <ReactJson
                    src={actualValue}
                    collapsed={autoExpandRow ? 2 : 1}
                    enableClipboard
                    displayDataTypes={false}
                    displayObjectSize={false}
                    name={null}
                />
            </div>
        );
    }

    return (
        <span className="truncate max-w-xs block">{String(actualValue)}</span>
    );
}

/**
 * Creates a standard text column with proper rendering
 */
export function createTextColumn<T>(
    key: string,
    header: string,
    options: {
        extractValue?: boolean;
        className?: string;
        autoExpandRow?: boolean;
    } = {}
): ColumnDef<T> {
    return {
        accessorKey: key,
        header,
        cell: ({ getValue }) => {
            const value = getValue();
            return renderCellValue(
                value,
                options.extractValue,
                options.autoExpandRow
            );
        },
    };
}

/**
 * Creates an ID column with monospace font styling and link to Entity Inspector
 */
export function createIdColumn<T>(options?: { linkToEntity?: boolean }): ColumnDef<T> {
  const linkToEntity = options?.linkToEntity ?? false
  return {
    accessorKey: 'id',
    header: 'ID',
    cell: ({ getValue }) => {
      const value = getValue() as string
      if (linkToEntity) {
        return (
          <Link
            to={`/entity/${value}`}
            className="font-mono text-xs text-primary hover:underline"
            title="Inspect entity"
          >
            {value}
          </Link>
        )
      }
      return <span className="font-mono text-xs">{value}</span>
    },
  }
}
